import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Nack } from '@golevelup/nestjs-rabbitmq';
import { InventoryService, RpcResult } from './inventory.service';
import { StockItem } from './entities/stock-item.entity';
import { Reservation, ReservationStatus } from './entities/reservation.entity';

describe('InventoryService', () => {
  let service: InventoryService;
  let reservationRepository: { findOne: jest.Mock };
  let stockRepository: { findOne: jest.Mock };
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
    decrement: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    reservationRepository = { findOne: jest.fn().mockResolvedValue(null) };
    stockRepository = { findOne: jest.fn() };

    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    manager = {
      // Existing stock by default, so ensureStockExists doesn't try to
      // create one unless a test explicitly wants to exercise that path.
      findOne: jest.fn().mockResolvedValue({ productId: 'p1' }),
      save: jest.fn((_entity, data) => Promise.resolve(data)),
      create: jest.fn((_entity, data) => data),
      createQueryBuilder: jest.fn(() => queryBuilder),
      decrement: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = { transaction: jest.fn((cb) => cb(manager)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: getRepositoryToken(StockItem), useValue: stockRepository },
        {
          provide: getRepositoryToken(Reservation),
          useValue: reservationRepository,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  describe('reserve', () => {
    it('reserves stock and records a Reservation when enough stock is available', async () => {
      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
      });

      expect(result).toEqual({ success: true });
      expect(queryBuilder.execute).toHaveBeenCalledTimes(1);
      expect(manager.create).toHaveBeenCalledWith(
        Reservation,
        expect.objectContaining({
          orderId: 'order-1',
          status: ReservationStatus.RESERVED,
        }),
      );
    });

    it('returns success: false when stock is insufficient (atomic update affects 0 rows)', async () => {
      queryBuilder.execute.mockResolvedValueOnce({ affected: 0 });

      const result = (await service.reserve({
        orderId: 'order-2',
        items: [{ productId: 'p1', quantity: 9999 }],
      })) as RpcResult;

      expect(result.success).toBe(false);
      expect(result.reason).toContain('insufficient_stock');
      // The Reservation must NOT be created when any item fails.
      expect(manager.save).not.toHaveBeenCalledWith(
        Reservation,
        expect.anything(),
      );
    });

    it('auto-seeds a new product with default stock instead of failing', async () => {
      manager.findOne.mockResolvedValueOnce(null); // stock row doesn't exist yet

      await service.reserve({
        orderId: 'order-3',
        items: [{ productId: 'brand-new-product', quantity: 1 }],
      });

      expect(manager.save).toHaveBeenCalledWith(
        StockItem,
        expect.objectContaining({
          productId: 'brand-new-product',
          availableQuantity: 1000,
        }),
      );
    });

    it('is idempotent: a redelivered request for an already-reserved order is a no-op', async () => {
      reservationRepository.findOne.mockResolvedValueOnce({
        status: ReservationStatus.RESERVED,
      });

      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
      });

      expect(result).toEqual({ success: true });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('reports failure for a redelivered request whose reservation was already released', async () => {
      reservationRepository.findOne.mockResolvedValueOnce({
        status: ReservationStatus.RELEASED,
      });

      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
      });

      expect(result).toEqual({ success: false });
    });

    it('poison-message backstop: Nacks straight to the DLQ instead of reprocessing when the AMQP message itself was redelivered (crash before ack)', async () => {
      const result = await service.reserve(
        { orderId: 'order-crash', items: [{ productId: 'p1', quantity: 2 }] },
        { fields: { redelivered: true } },
      );

      expect(result).toBeInstanceOf(Nack);
      expect((result as Nack).requeue).toBe(false);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('returns reservation_not_found when there is nothing to confirm', async () => {
      reservationRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.confirm({ orderId: 'missing-order' });

      expect(result).toEqual({
        success: false,
        reason: 'reservation_not_found',
      });
    });

    it('decrements available and reserved quantity, then marks the reservation CONFIRMED', async () => {
      reservationRepository.findOne.mockResolvedValueOnce({
        orderId: 'order-1',
        status: ReservationStatus.RESERVED,
        items: [{ productId: 'p1', quantity: 2 }],
      });

      const result = await service.confirm({ orderId: 'order-1' });

      expect(result).toEqual({ success: true });
      expect(manager.decrement).toHaveBeenCalledWith(
        StockItem,
        { productId: 'p1' },
        'availableQuantity',
        2,
      );
      expect(manager.decrement).toHaveBeenCalledWith(
        StockItem,
        { productId: 'p1' },
        'reservedQuantity',
        2,
      );
      expect(manager.save).toHaveBeenCalledWith(
        Reservation,
        expect.objectContaining({ status: ReservationStatus.CONFIRMED }),
      );
    });

    it('is idempotent: confirming an already-confirmed reservation is a no-op', async () => {
      reservationRepository.findOne.mockResolvedValueOnce({
        status: ReservationStatus.CONFIRMED,
      });

      const result = await service.confirm({ orderId: 'order-1' });

      expect(result).toEqual({ success: true });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('returns success without a transaction when there is nothing to release', async () => {
      reservationRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.release({ orderId: 'missing-order' });

      expect(result).toEqual({ success: true });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('decrements only reservedQuantity (compensating action) and marks RELEASED', async () => {
      reservationRepository.findOne.mockResolvedValueOnce({
        orderId: 'order-1',
        status: ReservationStatus.RESERVED,
        items: [{ productId: 'p1', quantity: 2 }],
      });

      const result = await service.release({ orderId: 'order-1' });

      expect(result).toEqual({ success: true });
      expect(manager.decrement).toHaveBeenCalledWith(
        StockItem,
        { productId: 'p1' },
        'reservedQuantity',
        2,
      );
      expect(manager.decrement).not.toHaveBeenCalledWith(
        StockItem,
        { productId: 'p1' },
        'availableQuantity',
        expect.anything(),
      );
      expect(manager.save).toHaveBeenCalledWith(
        Reservation,
        expect.objectContaining({ status: ReservationStatus.RELEASED }),
      );
    });

    it('is idempotent: releasing an already-released reservation is a no-op', async () => {
      reservationRepository.findOne.mockResolvedValueOnce({
        status: ReservationStatus.RELEASED,
      });

      const result = await service.release({ orderId: 'order-1' });

      expect(result).toEqual({ success: true });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
