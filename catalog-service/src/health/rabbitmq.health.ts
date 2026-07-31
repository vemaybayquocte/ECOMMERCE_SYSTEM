import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

@Injectable()
export class RabbitMQHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly amqpConnection: AmqpConnection,
  ) {}

  check(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const isConnected = this.amqpConnection.managedConnection.isConnected();

    if (!isConnected) {
      return indicator.down('RabbitMQ connection is down');
    }

    return indicator.up();
  }
}
