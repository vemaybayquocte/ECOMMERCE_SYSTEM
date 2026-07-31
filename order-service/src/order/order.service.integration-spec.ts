import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';

/**
 * Runs the exact persistence path (real Postgres, real transaction, real
 * jsonb round-trip) that the mock-based order.service.spec.ts cannot: this
 * is what should have caught the "order total used the client-supplied
 * price instead of catalog's" bug before it ever reached a real cluster.
 * Only the cross-service RPC (catalog.get-prices) is mocked - verifying
 * that call actually happens end to end is the e2e saga test's job.
 */
describe('OrderService (integration, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let service: OrderService;
  let amqpConnection: { request: jest.Mock };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [Order, OutboxEvent],
      synchronize: true,
    });
    await dataSource.initialize();
  }, 120_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE orders, outbox_events CASCADE');
    amqpConnection = { request: jest.fn() };
    service = new OrderService(dataSource, amqpConnection as any);
  });

  it('prices items from catalog, ignoring any client-supplied price', async () => {
    amqpConnection.request.mockResolvedValue({
      prices: [{ productId: 'p1', price: 100 }],
      missing: [],
    });

    const order = await service.createOrder({
      customerId: 'c1',
      items: [{ productId: 'p1', quantity: 2, price: 1 } as any],
    });

    expect(order.total).toBe(200);
    expect(order.items[0].price).toBe(100);
  });

  it('persists the order and its outbox event in the same transaction, with matching payload', async () => {
    amqpConnection.request.mockResolvedValue({
      prices: [{ productId: 'p1', price: 50 }],
      missing: [],
    });

    const order = await service.createOrder({
      customerId: 'c1',
      items: [{ productId: 'p1', quantity: 1, price: 999 } as any],
    });

    const persistedOrder = await dataSource
      .getRepository(Order)
      .findOne({ where: { id: order.id } });
    const outboxRow = await dataSource
      .getRepository(OutboxEvent)
      .findOne({ where: { aggregateId: order.id } });

    expect(persistedOrder).not.toBeNull();
    expect(persistedOrder!.status).toBe(OrderStatus.PENDING);
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.aggregateType).toBe('Order');
    expect(outboxRow!.eventType).toBe('order.created');
    expect((outboxRow!.payload as any).total).toBe(50);
    expect((outboxRow!.payload as any).orderId).toBe(order.id);
  });

  it('rejects and persists nothing when catalog reports the product as unknown', async () => {
    amqpConnection.request.mockResolvedValue({
      prices: [],
      missing: ['unknown-product'],
    });

    await expect(
      service.createOrder({
        customerId: 'c1',
        items: [
          { productId: 'unknown-product', quantity: 1, price: 10 } as any,
        ],
      }),
    ).rejects.toThrow(BadRequestException);

    const count = await dataSource.getRepository(Order).count();
    expect(count).toBe(0);
  });
});
