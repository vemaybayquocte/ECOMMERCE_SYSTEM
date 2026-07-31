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
      }),
    }),
  ],
  exports: [RabbitMQModule],
})
export class SharedRabbitMQModule {}
