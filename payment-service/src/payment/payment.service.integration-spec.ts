import { Nack } from '@golevelup/nestjs-rabbitmq';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PaymentService } from './payment.service';
import { Payment } from './entities/payment.entity';

/**
 * Real Postgres instead of a mocked Repository - proves the idempotency
 * check (findOne by orderId before inserting) actually prevents a
 * duplicate row on a real unique lookup, not just on a manually-scripted
 * mock return value.
 */
describe('PaymentService (integration, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let service: PaymentService;
  let amqpConnection: { publish: jest.Mock };
  let randomSpy: jest.SpyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [Payment],
      synchronize: true,
    });
    await dataSource.initialize();
  }, 120_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE payments CASCADE');
    amqpConnection = { publish: jest.fn().mockResolvedValue(undefined) };
    const configService = { get: (_key: string, def: unknown) => def } as any;
    service = new PaymentService(
      dataSource.getRepository(Payment),
      amqpConnection as any,
      configService,
    );
  });

  afterEach(() => {
    randomSpy?.mockRestore();
  });

  // callPaymentGateway draws Math.random() twice: once for the transient
  // failure roll, once for the success/decline roll.
  function mockGatewayOutcome(transientRoll: number, successRoll: number) {
    const values = [transientRoll, successRoll];
    randomSpy = jest
      .spyOn(global.Math, 'random')
      .mockImplementation(() => values.shift() ?? 0.5);
  }

  it('persists a SUCCESS payment and publishes payment.succeeded', async () => {
    mockGatewayOutcome(0.9, 0.1);

    await service.handlePaymentRequested(
      { orderId: 'o1', customerId: 'c1', total: 42 },
      undefined,
      {},
    );

    const payment = await dataSource
      .getRepository(Payment)
      .findOne({ where: { orderId: 'o1' } });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('SUCCESS');
    expect(amqpConnection.publish).toHaveBeenCalledWith(
      'ecommerce.events',
      'payment.succeeded',
      expect.objectContaining({ orderId: 'o1', status: 'SUCCESS' }),
    );
  });

  it('is idempotent: redelivering the same orderId does not create a duplicate payment row', async () => {
    mockGatewayOutcome(0.9, 0.1);
    await service.handlePaymentRequested(
      { orderId: 'o2', customerId: 'c1', total: 10 },
      undefined,
      {},
    );

    amqpConnection.publish.mockClear();
    // Redelivery of the same message (at-least-once broker semantics) -
    // must not attempt to charge/insert again.
    await service.handlePaymentRequested(
      { orderId: 'o2', customerId: 'c1', total: 10 },
      undefined,
      {},
    );

    const count = await dataSource
      .getRepository(Payment)
      .count({ where: { orderId: 'o2' } });
    expect(count).toBe(1);
    expect(amqpConnection.publish).not.toHaveBeenCalled();
  });

  it('returns Nack and persists nothing on a transient gateway failure', async () => {
    mockGatewayOutcome(0.01, 0.1);

    const result = await service.handlePaymentRequested(
      { orderId: 'o3', customerId: 'c1', total: 10 },
      undefined,
      {},
    );

    expect(result).toBeInstanceOf(Nack);
    const count = await dataSource
      .getRepository(Payment)
      .count({ where: { orderId: 'o3' } });
    expect(count).toBe(0);
  });
});
