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
        const dlqExchange = `${exchange}.dlq`;

        return {
          exchanges: [
            { name: exchange, type: 'topic' },
            { name: dlqExchange, type: 'topic' },
          ],
          queues: [
            // Poison-message backstop: reserve/confirm/release already
            // never throw (they catch everything and return a typed
            // result), so the only way a message loops forever is a real
            // process crash mid-handler, before it can ack. inventory.service.ts
            // Nacks any redelivered message straight here instead of
            // reprocessing it, rather than risking another crash on the
            // same poisonous payload.
            {
              name: 'inventory.requests-queue.dlq',
              exchange: dlqExchange,
              routingKey: 'inventory.requests',
              options: { durable: true },
            },
          ],
          uri: config.get<string>('RABBITMQ_URI'),
          connectionInitOptions: { wait: false },
          // Bulkhead: caps in-flight messages per replica. reserve/confirm/
          // release are fast DB-transaction operations (no artificial
          // delay), so this is higher than payment-service's - it mostly
          // protects inventory-db's own connection pool from a burst.
          prefetchCount: config.get<number>('RABBITMQ_PREFETCH_COUNT', 20),
        };
      },
    }),
  ],
  exports: [RabbitMQModule],
})
export class SharedRabbitMQModule {}
