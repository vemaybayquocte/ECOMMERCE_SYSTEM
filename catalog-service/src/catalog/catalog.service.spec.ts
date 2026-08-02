import { ConflictException } from '@nestjs/common';
import { Nack } from '@golevelup/nestjs-rabbitmq';
import { CatalogService } from './catalog.service';

describe('CatalogService', () => {
  let service: CatalogService;
  let productRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(() => {
    productRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'p-uuid', ...data })),
    };
    service = new CatalogService(productRepository as any);
  });

  describe('create', () => {
    it('rejects a productId that is already registered', async () => {
      productRepository.findOne.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create({ productId: 'p1', name: 'Widget', price: 10 }),
      ).rejects.toThrow(ConflictException);
      expect(productRepository.save).not.toHaveBeenCalled();
    });

    it('persists a new product', async () => {
      productRepository.findOne.mockResolvedValue(null);

      const result = await service.create({
        productId: 'p1',
        name: 'Widget',
        price: 10,
      });

      expect(productRepository.save).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ productId: 'p1', name: 'Widget', price: 10 }),
      );
    });
  });

  describe('getPrices', () => {
    it('returns real prices for known products and lists unknown ones as missing', async () => {
      productRepository.find.mockResolvedValue([
        { productId: 'p1', price: 10 },
        { productId: 'p2', price: 20 },
      ]);

      const result = await service.getPrices({
        productIds: ['p1', 'p2', 'p-unknown'],
      });

      expect(result).toEqual({
        prices: [
          { productId: 'p1', price: 10 },
          { productId: 'p2', price: 20 },
        ],
        missing: ['p-unknown'],
      });
    });

    it('never throws: treats a repository failure as all-missing', async () => {
      productRepository.find.mockRejectedValue(new Error('db down'));

      const result = await service.getPrices({ productIds: ['p1', 'p2'] });

      expect(result).toEqual({ prices: [], missing: ['p1', 'p2'] });
    });

    it('poison-message backstop: Nacks straight to the DLQ instead of reprocessing when the AMQP message itself was redelivered (crash before ack)', async () => {
      const result = await service.getPrices(
        { productIds: ['p1'] },
        { fields: { redelivered: true } },
      );

      expect(result).toBeInstanceOf(Nack);
      expect((result as Nack).requeue).toBe(false);
      expect(productRepository.find).not.toHaveBeenCalled();
    });
  });
});
