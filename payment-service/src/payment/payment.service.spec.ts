import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { AmqpConnection, Nack } from '@golevelup/nestjs-rabbitmq';
import { PaymentService } from './payment.service';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { OrderCreatedEvent } from './events/order-created.event';

describe('PaymentService', () => {
  let paymentRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let amqpConnection: { publish: jest.Mock };
  let randomSpy: jest.SpyInstance;

  const baseEvent: OrderCreatedEvent = {
    orderId: 'order-1',
    customerId: 'cust-1',
    total: 100,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };

  async function buildService(
    transientFailureRate = 0,
  ): Promise<PaymentService> {
    paymentRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'payment-1', ...data })),
    };
    amqpConnection = { publish: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepository },
        { provide: AmqpConnection, useValue: amqpConnection },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) => {
              if (key === 'PAYMENT_TRANSIENT_FAILURE_RATE') {
                return transientFailureRate;
              }
              return def;
            }),
          },
        },
      ],
    }).compile();

    return module.get(PaymentService);
  }

  afterEach(() => {
    randomSpy?.mockRestore();
  });

  it('skips reprocessing when a payment for the order already exists (idempotency)', async () => {
    const service = await buildService();
    paymentRepository.findOne.mockResolvedValueOnce({
      id: 'existing-payment',
      status: PaymentStatus.SUCCESS,
    });

    const result = await service.handleOrderCreated(baseEvent, {}, {});

    expect(result).toBeUndefined();
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('saves a SUCCESS payment when the simulated gateway call succeeds', async () => {
    const service = await buildService(0);
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5); // < 0.85 -> SUCCESS

    await service.handleOrderCreated(baseEvent, {}, {});

    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        status: PaymentStatus.SUCCESS,
      }),
    );
  });

  it('saves a FAILED payment (business decline) without touching the DLQ', async () => {
    const service = await buildService(0);
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.99); // >= 0.85 -> FAILED

    await service.handleOrderCreated(baseEvent, {}, {});

    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED }),
    );
    expect(amqpConnection.publish).not.toHaveBeenCalled();
  });

  it('returns Nack(false) on a transient gateway error instead of throwing', async () => {
    // Force the transient-failure branch: transientFailureRate = 1 means
    // Math.random() < 1 is always true.
    const service = await buildService(1);

    const result = await service.handleOrderCreated(baseEvent, {}, {});

    expect(result).toBeInstanceOf(Nack);
    expect((result as Nack).requeue).toBe(false);
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('routes to the DLQ instead of reprocessing once the retry count reaches the max', async () => {
    const service = await buildService();
    const headers = { 'x-death': [{ count: 3 }] };

    const result = await service.handleOrderCreated(baseEvent, {}, headers);

    expect(result).toBeUndefined();
    expect(amqpConnection.publish).toHaveBeenCalledWith(
      'ecommerce.events.dlq',
      'order.created',
      baseEvent,
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });
});
