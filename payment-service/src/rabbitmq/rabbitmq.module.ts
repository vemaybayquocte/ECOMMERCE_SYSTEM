import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';

@Global()
@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const exchange = config.get<string>(
          'RABBITMQ_EXCHANGE',
          'ecommerce.events',
        );
        const retryExchange = `${exchange}.retry`;
        const dlqExchange = `${exchange}.dlq`;

        return {
          exchanges: [
            { name: exchange, type: 'topic' },
            { name: retryExchange, type: 'topic' },
            { name: dlqExchange, type: 'topic' },
          ],
          queues: [
            // 3 staged delay queues (2s/5s/12s) instead of 1 fixed 5s queue:
            // payment.service.ts picks which one to publish a failed
            // message into based on its current x-death count, giving
            // real exponential backoff. Each still dead-letters back to
            // the main exchange after its own TTL elapses - only the
            // "which queue to enter" decision is made in application
            // code, because a queue's dead-letter target is static and
            // can't be chosen per-message through Nack alone (there's no
            // delayed-message-exchange plugin installed on this cluster).
            {
              name: 'payment.requested-queue.retry-1',
              exchange: retryExchange,
              routingKey: 'payment.requested.retry-1',
              options: {
                durable: true,
                arguments: {
                  'x-message-ttl': 2000,
                  'x-dead-letter-exchange': exchange,
                  'x-dead-letter-routing-key': 'payment.requested',
                },
              },
            },
            {
              name: 'payment.requested-queue.retry-2',
              exchange: retryExchange,
              routingKey: 'payment.requested.retry-2',
              options: {
                durable: true,
                arguments: {
                  'x-message-ttl': 5000,
                  'x-dead-letter-exchange': exchange,
                  'x-dead-letter-routing-key': 'payment.requested',
                },
              },
            },
            {
              name: 'payment.requested-queue.retry-3',
              exchange: retryExchange,
              routingKey: 'payment.requested.retry-3',
              options: {
                durable: true,
                arguments: {
                  'x-message-ttl': 12000,
                  'x-dead-letter-exchange': exchange,
                  'x-dead-letter-routing-key': 'payment.requested',
                },
              },
            },
            {
              // Final resting place for messages that exceeded the retry limit.
              name: 'payment.requested-queue.dlq',
              exchange: dlqExchange,
              routingKey: 'payment.requested',
              options: { durable: true },
            },
          ],
          uri: config.get<string>('RABBITMQ_URI'),
          connectionInitOptions: { wait: false },
          // Bulkhead: caps in-flight messages per replica so one pod can't
          // claim unbounded work off the queue and starve the DB
          // connection pool. callPaymentGateway has a ~500ms simulated
          // delay, so 10 keeps a single replica's concurrent payments
          // bounded to something the DB pool can actually sustain.
          prefetchCount: config.get<number>('RABBITMQ_PREFETCH_COUNT', 10),
        };
      },
    }),
  ],
  exports: [RabbitMQModule],
})
export class SharedRabbitMQModule {}
