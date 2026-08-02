import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';

@Global()
@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        exchanges: [
          {
            name: config.get<string>('RABBITMQ_EXCHANGE', 'ecommerce.events'),
            type: 'topic',
          },
        ],
        uri: config.get<string>('RABBITMQ_URI'),
        connectionInitOptions: { wait: false },
        // Bulkhead: caps in-flight messages per replica so one pod can't
        // claim unbounded work off the queue and starve the DB pool.
        // Saga handlers do a DB write plus an outbound circuit-breaker-
        // wrapped RPC, so this sits between payment-service's slow-call
        // bulkhead and inventory/catalog's fast-query one.
        prefetchCount: config.get<number>('RABBITMQ_PREFETCH_COUNT', 15),
      }),
    }),
  ],
  exports: [RabbitMQModule],
})
export class SharedRabbitMQModule {}
