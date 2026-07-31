import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { NotificationModule } from './notification/notification.module';
import { MetricsModule } from './metrics/metrics.module';
import { SharedRabbitMQModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedRabbitMQModule,
    NotificationModule,
    HealthModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
