import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AmqpConnection, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import * as CircuitBreaker from 'opossum';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { OrderCreatedEvent } from '../order/events/order-created.event';
import { InventoryRpcResult, PaymentResultEvent } from './events';

const EXCHANGE = 'ecommerce.events';

interface InventoryRpcRequest {
  routingKey: 'inventory.reserve' | 'inventory.confirm' | 'inventory.release';
  payload: Record<string, unknown>;
}

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
  private readonly inventoryRpcTimeoutMs: number;
  // One breaker per inventory RPC operation: a burst of reserve failures
  // (e.g. inventory-service down) shouldn't make every order wait out the
  // full RPC timeout — once the failure rate crosses the threshold the
  // breaker opens and rejects instantly until inventory-service recovers.
  private readonly breaker: CircuitBreaker<
    [InventoryRpcRequest],
    InventoryRpcResult
  >;

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly amqpConnection: AmqpConnection,
    private readonly configService: ConfigService,
  ) {
    this.inventoryRpcTimeoutMs = this.configService.get<number>(
      'INVENTORY_RPC_TIMEOUT_MS',
      10_000,
    );
    this.breaker = new CircuitBreaker(
      (req: InventoryRpcRequest) => this.callInventory(req),
      {
        timeout: this.inventoryRpcTimeoutMs + 1_000,
        errorThresholdPercentage: 50,
        resetTimeout: 10_000,
        rollingCountTimeout: 10_000,
      },
    );
  }

  private callInventory(req: InventoryRpcRequest): Promise<InventoryRpcResult> {
    return this.amqpConnection.request<InventoryRpcResult>({
      exchange: EXCHANGE,
      routingKey: req.routingKey,
      payload: req.payload,
      timeout: this.inventoryRpcTimeoutMs,
    });
  }

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
      reserveResult = await this.breaker.fire({
        routingKey: 'inventory.reserve',
        payload: { orderId: event.orderId, items: event.items },
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
      const result = await this.breaker.fire({
        routingKey: 'inventory.confirm',
        payload: { orderId: event.orderId },
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
      await this.breaker.fire({
        routingKey: 'inventory.release',
        payload: { orderId: event.orderId },
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

  private async setStatus(orderId: string, status: OrderStatus): Promise<void> {
    try {
      await this.orderRepository.update({ id: orderId }, { status });
    } catch (err) {
      this.logger.error(
        `Failed to update order ${orderId} status to ${status}: ${(err as Error).message}`,
      );
      return;
    }

    // Only notify on terminal outcomes - INVENTORY_RESERVED is an
    // intermediate step, not something worth telling the customer about.
    if (status === OrderStatus.COMPLETED || status === OrderStatus.CANCELLED) {
      await this.publishStatusChanged(orderId, status);
    }
  }

  private async publishStatusChanged(
    orderId: string,
    status: OrderStatus,
  ): Promise<void> {
    try {
      const order = await this.orderRepository.findOne({
        where: { id: orderId },
      });
      if (!order) {
        return;
      }

      await this.amqpConnection.publish(EXCHANGE, 'order.status-changed', {
        orderId,
        customerId: order.customerId,
        status,
      });
    } catch (err) {
      this.logger.error(
        `Failed to publish order.status-changed for order ${orderId}: ${(err as Error).message}`,
      );
    }
  }
}
