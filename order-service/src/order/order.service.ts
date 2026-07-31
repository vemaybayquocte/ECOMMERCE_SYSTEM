import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order, OrderItem } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OrderCreatedEvent } from './events/order-created.event';

const EXCHANGE = 'ecommerce.events';
const CATALOG_RPC_TIMEOUT_MS = 10_000;

interface GetPricesResult {
  prices: { productId: string; price: number }[];
  missing: string[];
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly amqpConnection: AmqpConnection,
  ) {}

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const items = await this.priceItems(dto.items);
    const total = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    return this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        Order,
        manager.create(Order, {
          customerId: dto.customerId,
          items,
          total,
        }),
      );

      const event: OrderCreatedEvent = {
        orderId: order.id,
        customerId: order.customerId,
        total: order.total,
        items: order.items,
        createdAt: order.createdAt.toISOString(),
      };

      // Same transaction as the order write: either both the order and this
      // outbox row exist, or neither does. A separate Debezium connector
      // captures this table via CDC and relays it to RabbitMQ, so the event
      // can never be silently lost even if the process crashes right here
      // (the old direct amqpConnection.publish() call had exactly that gap).
      await manager.save(
        OutboxEvent,
        manager.create(OutboxEvent, {
          aggregateType: 'Order',
          aggregateId: order.id,
          eventType: 'order.created',
          payload: event as unknown as Record<string, unknown>,
        }),
      );

      this.logger.log(`Order ${order.id} created (outbox event recorded)`);

      return order;
    });
  }

  // Looks up the authoritative price per productId from catalog-service
  // instead of trusting whatever the client sends - a client could
  // otherwise set an arbitrary price on any item.
  private async priceItems(
    items: { productId: string; quantity: number }[],
  ): Promise<OrderItem[]> {
    const productIds = items.map((item) => item.productId);

    let result: GetPricesResult;
    try {
      result = await this.amqpConnection.request<GetPricesResult>({
        exchange: EXCHANGE,
        routingKey: 'catalog.get-prices',
        payload: { productIds },
        timeout: CATALOG_RPC_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error(
        `catalog.get-prices RPC failed: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        'Unable to verify product prices right now',
      );
    }

    if (result.missing.length > 0) {
      throw new BadRequestException(
        `Unknown product(s): ${result.missing.join(', ')}`,
      );
    }

    const priceByProductId = new Map(
      result.prices.map((p) => [p.productId, p.price]),
    );

    return items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      price: priceByProductId.get(item.productId) as number,
    }));
  }
}
