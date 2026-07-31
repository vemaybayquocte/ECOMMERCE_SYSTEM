import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Consumer, Kafka } from 'kafkajs';

/**
 * Bridges the transactional outbox to RabbitMQ: consumes the Kafka topic
 * Debezium's Outbox Event Router produces from `outbox_events` (CDC on a
 * Postgres table that's written in the same DB transaction as the Order
 * row) and republishes each event to RabbitMQ, exactly like the old direct
 * amqpConnection.publish() call used to.
 *
 * Because the outbox row is durable and Kafka retains the message until
 * consumed, an order.created event can no longer be lost even if this
 * service (or the whole order-service process) crashes mid-flight — on
 * restart it just resumes from the last committed Kafka offset.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly kafka: Kafka;
  private consumer: Consumer;
  private readonly exchange: string;
  private readonly topic = 'outbox.event.Order';
  private destroyed = false;
  private readonly maxBackoffMs = 30_000;

  constructor(
    private readonly amqpConnection: AmqpConnection,
    private readonly configService: ConfigService,
  ) {
    this.exchange = this.configService.get<string>(
      'RABBITMQ_EXCHANGE',
      'ecommerce.events',
    );
    this.kafka = new Kafka({
      clientId: 'order-service-outbox-relay',
      brokers: [
        this.configService.get<string>('KAFKA_BROKERS', 'localhost:9092'),
      ],
    });
  }

  onModuleInit() {
    // Fire-and-forget: connecting to Kafka must never block app bootstrap
    // (HTTP/health/metrics should come up even if Kafka isn't reachable yet),
    // and any rejection here must never escape as an unhandled promise
    // rejection — that's what used to crash the whole process once kafkajs
    // exhausted its internal connect retries.
    void this.connectWithRetry();
  }

  private async connectWithRetry(attempt = 0): Promise<void> {
    if (this.destroyed) {
      return;
    }

    try {
      this.consumer = this.kafka.consumer({ groupId: 'outbox-relay' });
      this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
        this.logger.error(
          `Outbox relay consumer crashed: ${payload.error.message}`,
        );
        // kafkajs auto-recovers when payload.restart is true; otherwise we
        // have to reconnect ourselves.
        if (!payload.restart && !this.destroyed) {
          void this.connectWithRetry();
        }
      });

      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: this.topic,
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) {
            return;
          }

          // Debezium represents the jsonb `payload` column as an opaque
          // string (not a nested struct), so the Outbox Event Router emits
          // that string as-is: with JsonConverter this comes across the wire
          // JSON-double-encoded (a JSON string containing JSON text). Parse
          // twice to unwrap it either way.
          let event = JSON.parse(message.value.toString());
          if (typeof event === 'string') {
            event = JSON.parse(event);
          }

          // This topic only ever carries 'order.created' events today (the
          // Outbox Event Router routes purely by aggregateType -> topic name).
          // If more Order event types are added later, route by eventType
          // instead of hardcoding this — e.g. via table.fields.additional.placement
          // to expose it as a Kafka header.
          await this.amqpConnection.publish(
            this.exchange,
            'order.created',
            event,
          );

          this.logger.log(
            `Relayed outbox event for order ${event.orderId} to RabbitMQ`,
          );
        },
      });

      this.logger.log(`Outbox relay subscribed to Kafka topic "${this.topic}"`);
    } catch (err) {
      const backoff = Math.min(1000 * 2 ** attempt, this.maxBackoffMs);
      this.logger.warn(
        `Outbox relay failed to connect to Kafka (attempt ${attempt + 1}): ${(err as Error).message}. Retrying in ${backoff}ms`,
      );
      await this.consumer?.disconnect().catch(() => undefined);
      setTimeout(() => void this.connectWithRetry(attempt + 1), backoff);
    }
  }

  async onModuleDestroy() {
    this.destroyed = true;
    await this.consumer?.disconnect();
  }
}
