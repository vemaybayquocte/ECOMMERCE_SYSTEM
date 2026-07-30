import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OrderCreatedEvent } from './events/order-created.event';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const total = dto.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    return this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        Order,
        manager.create(Order, {
          customerId: dto.customerId,
          items: dto.items,
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
}
