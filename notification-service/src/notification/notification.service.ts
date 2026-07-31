import { Inject, Injectable, Logger } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { NOTIFICATION_SENDER, NotificationSender } from './notification-sender';
import { OrderStatusChangedEvent } from './order-status-changed.event';

const EXCHANGE = 'ecommerce.events';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(NOTIFICATION_SENDER)
    private readonly sender: NotificationSender,
  ) {}

  // Same rule as every other RabbitMQ handler in this system: never throw
  // past this boundary. golevelup routes a thrown exception through Nest's
  // HTTP ExceptionsHandler (this service also serves /health and /metrics),
  // which silently breaks ack/nack instead of surfacing the error.
  @RabbitSubscribe({
    exchange: EXCHANGE,
    routingKey: 'order.status-changed',
    queue: 'notification.order-status-changed-queue',
    queueOptions: { durable: true },
  })
  async handleOrderStatusChanged(
    event: OrderStatusChangedEvent,
  ): Promise<void> {
    try {
      await this.sender.send(
        event.customerId,
        `Order ${event.orderId} is now ${event.status}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to notify customer ${event.customerId} for order ${event.orderId}: ${(err as Error).message}`,
      );
    }
  }
}
