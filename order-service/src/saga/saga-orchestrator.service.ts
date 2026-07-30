import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AmqpConnection, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { OrderCreatedEvent } from '../order/events/order-created.event';
import { InventoryRpcResult, PaymentResultEvent } from './events';

const EXCHANGE = 'ecommerce.events';
const RPC_TIMEOUT_MS = 10_000;

/**
 * Orchestrated saga for "create order": reserve inventory -> request payment
 * -> confirm inventory (success) or release it (compensating action on
 * failure). Inventory calls are RPC (fast, synchronous, no external
 * gateway delay) while payment stays fire-and-forget pub/sub so
 * payment-service's existing retry/DLX machinery is untouched.
 *
 * Every handler below swallows its own errors instead of letting them
 * propagate: a thrown exception here would hit Nest's HTTP-oriented
 * ExceptionsHandler (this service also serves HTTP routes) and silently
 * break message ack/nack — the same bug fixed earlier in payment-service
 * by returning Nack instead of throwing.
 */
@Injectable()
export class SagaOrchestratorService {
  private readonly logger = new Logger(SagaOrchestratorService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly amqpConnection: AmqpConnection,
  ) {}

  @RabbitSubscribe({
    exchange: EXCHANGE,
    routingKey: 'order.created',
    queue: 'saga.order-created-queue',
    queueOptions: { durable: true },
  })
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    this.logger.log(`Saga started for order ${event.orderId}`);

    let reserveResult: InventoryRpcResult;
    try {
      reserveResult = await this.amqpConnection.request<InventoryRpcResult>({
        exchange: EXCHANGE,
        routingKey: 'inventory.reserve',
        payload: { orderId: event.orderId, items: event.items },
        timeout: RPC_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error(
        `inventory.reserve RPC failed for order ${event.orderId}: ${(err as Error).message}`,
      );
      await this.setStatus(event.orderId, OrderStatus.CANCELLED);
      return;
    }

    if (!reserveResult.success) {
      this.logger.warn(
        `Inventory reservation declined for order ${event.orderId}: ${reserveResult.reason}`,
      );
      await this.setStatus(event.orderId, OrderStatus.CANCELLED);
      return;
    }

    await this.setStatus(event.orderId, OrderStatus.INVENTORY_RESERVED);

    try {
      await this.amqpConnection.publish(EXCHANGE, 'payment.requested', {
        orderId: event.orderId,
        customerId: event.customerId,
        total: event.total,
      });
      this.logger.log(`Requested payment for order ${event.orderId}`);
    } catch (err) {
      this.logger.error(
        `Failed to publish payment.requested for order ${event.orderId}: ${(err as Error).message}`,
      );
    }
  }

  @RabbitSubscribe({
    exchange: EXCHANGE,
    routingKey: 'payment.succeeded',
    queue: 'saga.payment-succeeded-queue',
    queueOptions: { durable: true },
  })
  async handlePaymentSucceeded(event: PaymentResultEvent): Promise<void> {
    try {
      const result = await this.amqpConnection.request<InventoryRpcResult>({
        exchange: EXCHANGE,
        routingKey: 'inventory.confirm',
        payload: { orderId: event.orderId },
        timeout: RPC_TIMEOUT_MS,
      });

      if (!result.success) {
        this.logger.error(
          `inventory.confirm declined for order ${event.orderId}: ${result.reason}`,
        );
        return;
      }
    } catch (err) {
      this.logger.error(
        `inventory.confirm RPC failed for order ${event.orderId}: ${(err as Error).message}`,
      );
      // Payment already succeeded; leave the order INVENTORY_RESERVED rather
      // than silently marking it COMPLETED so this is visible for follow-up.
      return;
    }

    await this.setStatus(event.orderId, OrderStatus.COMPLETED);
    this.logger.log(`Order ${event.orderId} COMPLETED`);
  }

  @RabbitSubscribe({
    exchange: EXCHANGE,
    routingKey: 'payment.failed',
    queue: 'saga.payment-failed-queue',
    queueOptions: { durable: true },
  })
  async handlePaymentFailed(event: PaymentResultEvent): Promise<void> {
    try {
      await this.amqpConnection.request<InventoryRpcResult>({
        exchange: EXCHANGE,
        routingKey: 'inventory.release',
        payload: { orderId: event.orderId },
        timeout: RPC_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error(
        `inventory.release RPC failed for order ${event.orderId}: ${(err as Error).message}`,
      );
    }

    await this.setStatus(event.orderId, OrderStatus.CANCELLED);
    this.logger.log(
      `Order ${event.orderId} CANCELLED (payment failed, inventory released)`,
    );
  }

  private async setStatus(
    orderId: string,
    status: OrderStatus,
  ): Promise<void> {
    try {
      await this.orderRepository.update({ id: orderId }, { status });
    } catch (err) {
      this.logger.error(
        `Failed to update order ${orderId} status to ${status}: ${(err as Error).message}`,
      );
    }
  }
}
