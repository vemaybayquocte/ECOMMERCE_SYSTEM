import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OrderService } from './order.service';
import { Order } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';

describe('OrderService', () => {
  let service: OrderService;
  let manager: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    manager = {
      create: jest.fn((_entity, data) => data),
      save: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn((cb) => cb(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OrderService, { provide: DataSource, useValue: dataSource }],
    }).compile();

    service = module.get(OrderService);
  });

  it('computes total from items and persists the Order via the transactional manager', async () => {
    const savedOrder = {
      id: 'order-1',
      customerId: 'c1',
      total: 200,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    manager.save.mockResolvedValueOnce(savedOrder).mockResolvedValueOnce({});

    const result = await service.createOrder({
      customerId: 'c1',
      items: [{ productId: 'p1', quantity: 2, price: 100 }],
    });

    expect(result).toBe(savedOrder);
    expect(manager.create).toHaveBeenCalledWith(
      Order,
      expect.objectContaining({ customerId: 'c1', total: 200 }),
    );
  });

  it('writes the OutboxEvent in the SAME transaction as the Order (atomicity)', async () => {
    const savedOrder = {
      id: 'order-2',
      customerId: 'c2',
      total: 50,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    manager.save.mockResolvedValueOnce(savedOrder).mockResolvedValueOnce({});

    await service.createOrder({
      customerId: 'c2',
      items: [{ productId: 'p2', quantity: 1, price: 50 }],
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.create).toHaveBeenCalledWith(
      OutboxEvent,
      expect.objectContaining({
        aggregateType: 'Order',
        aggregateId: 'order-2',
        eventType: 'order.created',
        payload: expect.objectContaining({ orderId: 'order-2', total: 50 }),
      }),
    );
    // Both the Order and the OutboxEvent were saved through the SAME
    // transactional manager instance handed to the callback — this is what
    // makes them atomic (both commit or both roll back together).
    expect(manager.save).toHaveBeenCalledTimes(2);
  });

  it('propagates a failure instead of silently succeeding if the outbox insert fails', async () => {
    manager.save
      .mockResolvedValueOnce({
        id: 'order-3',
        customerId: 'c3',
        total: 10,
        createdAt: new Date(),
      })
      .mockRejectedValueOnce(new Error('DB error on outbox insert'));

    await expect(
      service.createOrder({
        customerId: 'c3',
        items: [{ productId: 'p3', quantity: 1, price: 10 }],
      }),
    ).rejects.toThrow('DB error on outbox insert');
  });
});
