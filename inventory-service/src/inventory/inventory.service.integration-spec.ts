import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { InventoryService } from './inventory.service';
import { StockItem } from './entities/stock-item.entity';
import { Reservation } from './entities/reservation.entity';

/**
 * The most important thing this real-Postgres suite proves that the
 * mock-based unit tests cannot: reserve()'s atomic conditional UPDATE
 * actually prevents oversell under real concurrent writes. A mocked
 * queryBuilder just returns whatever a test tells it to - it can't
 * demonstrate that the WHERE clause is what makes two racing reservations
 * safe.
 */
describe('InventoryService (integration, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let service: InventoryService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [StockItem, Reservation],
      synchronize: true,
    });
    await dataSource.initialize();
  }, 120_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE stock_items, reservations CASCADE');
    service = new InventoryService(
      dataSource.getRepository(StockItem),
      dataSource.getRepository(Reservation),
      dataSource,
    );
  });

  it('auto-seeds stock for a new product and reserves the requested quantity', async () => {
    const result = await service.reserve({
      orderId: 'o1',
      items: [{ productId: 'p1', quantity: 3 }],
    });

    expect(result.success).toBe(true);
    const stock = await dataSource
      .getRepository(StockItem)
      .findOne({ where: { productId: 'p1' } });
    expect(stock!.availableQuantity).toBe(1000);
    expect(stock!.reservedQuantity).toBe(3);
  });

  it('prevents oversell: of two concurrent reservations exceeding available stock, only one succeeds', async () => {
    await dataSource.getRepository(StockItem).save({
      productId: 'scarce',
      availableQuantity: 5,
      reservedQuantity: 0,
    });

    const [first, second] = await Promise.all([
      service.reserve({
        orderId: 'a',
        items: [{ productId: 'scarce', quantity: 4 }],
      }),
      service.reserve({
        orderId: 'b',
        items: [{ productId: 'scarce', quantity: 4 }],
      }),
    ]);

    const successes = [first, second].filter((r) => r.success);
    expect(successes).toHaveLength(1);

    const stock = await dataSource
      .getRepository(StockItem)
      .findOne({ where: { productId: 'scarce' } });
    expect(stock!.reservedQuantity).toBe(4);
  });

  it('is idempotent: reserving the same orderId twice does not double-reserve', async () => {
    await service.reserve({
      orderId: 'o2',
      items: [{ productId: 'p2', quantity: 2 }],
    });
    const second = await service.reserve({
      orderId: 'o2',
      items: [{ productId: 'p2', quantity: 2 }],
    });

    expect(second.success).toBe(true);
    const stock = await dataSource
      .getRepository(StockItem)
      .findOne({ where: { productId: 'p2' } });
    expect(stock!.reservedQuantity).toBe(2);
  });

  it('confirm() decrements both available and reserved quantity', async () => {
    await service.reserve({
      orderId: 'o3',
      items: [{ productId: 'p3', quantity: 5 }],
    });
    const result = await service.confirm({ orderId: 'o3' });

    expect(result.success).toBe(true);
    const stock = await dataSource
      .getRepository(StockItem)
      .findOne({ where: { productId: 'p3' } });
    expect(stock!.availableQuantity).toBe(995);
    expect(stock!.reservedQuantity).toBe(0);
  });

  it('release() decrements only reserved quantity, restoring availability for future reservations', async () => {
    await service.reserve({
      orderId: 'o4',
      items: [{ productId: 'p4', quantity: 5 }],
    });
    const result = await service.release({ orderId: 'o4' });

    expect(result.success).toBe(true);
    const stock = await dataSource
      .getRepository(StockItem)
      .findOne({ where: { productId: 'p4' } });
    expect(stock!.availableQuantity).toBe(1000);
    expect(stock!.reservedQuantity).toBe(0);
  });
});
