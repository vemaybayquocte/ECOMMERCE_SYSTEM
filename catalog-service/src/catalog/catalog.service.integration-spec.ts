import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { CatalogService } from './catalog.service';
import { Product } from './entities/product.entity';

/**
 * Real Postgres proves the unique-productId constraint and the
 * getPrices() RPC's known/missing split against actual persisted rows -
 * exactly the layer that was silently wrong when order-service trusted
 * client-supplied prices instead of this lookup.
 */
describe('CatalogService (integration, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let service: CatalogService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [Product],
      synchronize: true,
    });
    await dataSource.initialize();
  }, 120_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE products CASCADE');
    service = new CatalogService(dataSource.getRepository(Product));
  });

  it('creates and persists a product', async () => {
    const product = await service.create({
      productId: 'p1',
      name: 'Widget',
      price: 25,
    });

    expect(product.id).toBeDefined();
    const found = await dataSource
      .getRepository(Product)
      .findOne({ where: { productId: 'p1' } });
    expect(found!.price).toBe(25);
  });

  it('rejects creating a duplicate productId', async () => {
    await service.create({ productId: 'p2', name: 'Widget', price: 10 });

    await expect(
      service.create({ productId: 'p2', name: 'Widget v2', price: 20 }),
    ).rejects.toThrow(ConflictException);
  });

  it('getPrices() returns known prices and lists unknown productIds as missing', async () => {
    await service.create({ productId: 'p3', name: 'A', price: 100 });
    await service.create({ productId: 'p4', name: 'B', price: 200 });

    const result = await service.getPrices({
      productIds: ['p3', 'p4', 'ghost'],
    });

    expect(result.prices).toEqual(
      expect.arrayContaining([
        { productId: 'p3', price: 100 },
        { productId: 'p4', price: 200 },
      ]),
    );
    expect(result.missing).toEqual(['ghost']);
  });
});
