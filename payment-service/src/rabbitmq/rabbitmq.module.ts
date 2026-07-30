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
            {
              // Holds failed messages for a fixed delay, then dead-letters
              // them back to the main exchange for another processing attempt.
              name: 'payment.order-created-queue.retry',
              exchange: retryExchange,
              routingKey: 'order.created',
              options: {
                durable: true,
                arguments: {
                  'x-message-ttl': 5000,
                  'x-dead-letter-exchange': exchange,
                  'x-dead-letter-routing-key': 'order.created',
                },
              },
            },
            {
              // Final resting place for messages that exceeded the retry limit.
              name: 'payment.order-created-queue.dlq',
              exchange: dlqExchange,
              routingKey: 'order.created',
              options: { durable: true },
            },
          ],
          uri: config.get<string>('RABBITMQ_URI'),
          connectionInitOptions: { wait: false },
        };
      },
    }),
  ],
  exports: [RabbitMQModule],
})
export class SharedRabbitMQModule {}
