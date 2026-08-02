import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { OrderService } from './order.service';
import { Order } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';

describe('OrderService', () => {
  let service: OrderService;
  let manager: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let amqpConnection: { request: jest.Mock };

  beforeEach(async () => {
    manager = {
      create: jest.fn((_entity, data) => data),
      save: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn((cb) => cb(manager)),
    };
    // Default: catalog-service knows every product this suite creates,
    // priced at 100 - individual tests override this as needed.
    amqpConnection = {
      request: jest.fn().mockResolvedValue({
        prices: [
          { productId: 'p1', price: 100 },
          { productId: 'p2', price: 50 },
          { productId: 'p3', price: 10 },
        ],
        missing: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: DataSource, useValue: dataSource },
        { provide: AmqpConnection, useValue: amqpConnection },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key, def) => def) },
        },
      ],
    }).compile();

    service = module.get(OrderService);
  });

  it('looks up real prices from catalog-service and computes the total from them', async () => {
    const savedOrder = {
      id: 'order-1',
      customerId: 'c1',
      total: 200,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    manager.save.mockResolvedValueOnce(savedOrder).mockResolvedValueOnce({});

    const result = await service.createOrder({
      customerId: 'c1',
      items: [{ productId: 'p1', quantity: 2 }],
    });

    expect(amqpConnection.request).toHaveBeenCalledWith(
      expect.objectContaining({
        routingKey: 'catalog.get-prices',
        payload: { productIds: ['p1'] },
      }),
    );
    expect(result).toBe(savedOrder);
    // total = 2 * 100 (the price catalog-service returned), never the
    // client's own input - the DTO no longer even accepts a price field.
    expect(manager.create).toHaveBeenCalledWith(
      Order,
      expect.objectContaining({
        customerId: 'c1',
        total: 200,
        items: [{ productId: 'p1', quantity: 2, price: 100 }],
      }),
    );
  });

  it('rejects the order if catalog-service reports an unknown product', async () => {
    amqpConnection.request.mockResolvedValue({
      prices: [],
      missing: ['p-unknown'],
    });

    await expect(
      service.createOrder({
        customerId: 'c1',
        items: [{ productId: 'p-unknown', quantity: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects the order if the catalog.get-prices RPC itself fails', async () => {
    amqpConnection.request.mockRejectedValue(new Error('RPC timeout'));

    await expect(
      service.createOrder({
        customerId: 'c1',
        items: [{ productId: 'p1', quantity: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
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
      items: [{ productId: 'p2', quantity: 1 }],
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
        items: [{ productId: 'p3', quantity: 1 }],
      }),
    ).rejects.toThrow('DB error on outbox insert');
  });
});
