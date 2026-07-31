import { ChildProcess, execSync, spawn } from 'child_process';
import * as http from 'http';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';

/**
 * System-level e2e test: drives a real HTTP order-creation request through
 * the entire saga - order-service's outbox -> Debezium CDC -> Kafka ->
 * OutboxRelayService -> RabbitMQ -> SagaOrchestratorService -> inventory +
 * payment RPC/pubsub - using the project's existing docker-compose.yml for
 * infra (no parallel test-only infra definition) and the same JWT_SECRET
 * every service already reads from its own .env.
 *
 * This is the regression test for the bug that shipped to a real cluster
 * before being caught: an order's total must come from catalog-service's
 * price, never the client-supplied one.
 */

const ROOT = `${__dirname}/../..`;
const JWT_SECRET = 'skkksdfwnekewn'; // matches order-service/.env and catalog-service/.env

const INFRA_SERVICES = [
  'rabbitmq',
  'order-db',
  'payment-db',
  'inventory-db',
  'catalog-db',
  'zookeeper',
  'kafka',
  'debezium-connect',
];

const HEALTHY_CONTAINERS = [
  'ecommerce-rabbitmq',
  'ecommerce-order-db',
  'ecommerce-payment-db',
  'ecommerce-inventory-db',
  'ecommerce-catalog-db',
];

const APP_SERVICES: { name: string; port: number }[] = [
  { name: 'order-service', port: 3001 },
  { name: 'payment-service', port: 3002 },
  { name: 'inventory-service', port: 3003 },
  { name: 'catalog-service', port: 3005 },
];

const spawnedProcesses: ChildProcess[] = [];

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function httpPost(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function isPortHealthy(port: number): Promise<boolean> {
  return httpGet(`http://localhost:${port}/health`)
    .then((r) => r.status === 200)
    .catch(() => false);
}

function isContainerHealthy(name: string): boolean {
  try {
    const status = execSync(
      `docker inspect -f '{{.State.Health.Status}}' ${name}`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    return status === 'healthy';
  } catch {
    return false;
  }
}

function registerOutboxConnector(): Promise<void> {
  const config = {
    name: 'outbox-connector',
    config: {
      'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
      'database.hostname': 'order-db',
      'database.port': '5432',
      'database.user': 'postgres',
      'database.password': 'postgres',
      'database.dbname': 'order_db',
      'topic.prefix': 'outboxcdc',
      'table.include.list': 'public.outbox_events',
      'plugin.name': 'pgoutput',
      'slot.name': 'debezium_outbox_slot',
      'publication.name': 'dbz_outbox_publication',
      'publication.autocreate.mode': 'filtered',
      'time.precision.mode': 'connect',
      'key.converter': 'org.apache.kafka.connect.json.JsonConverter',
      'value.converter': 'org.apache.kafka.connect.json.JsonConverter',
      'key.converter.schemas.enable': 'false',
      'value.converter.schemas.enable': 'false',
      transforms: 'outbox',
      'transforms.outbox.type': 'io.debezium.transforms.outbox.EventRouter',
      'transforms.outbox.table.field.event.id': 'id',
      'transforms.outbox.table.field.event.key': 'aggregateId',
      'transforms.outbox.table.field.event.type': 'eventType',
      'transforms.outbox.table.field.event.payload': 'payload',
      'transforms.outbox.route.by.field': 'aggregateType',
      'transforms.outbox.route.topic.replacement':
        'outbox.event.${routedByValue}',
    },
  };

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(config);
    const req = http.request(
      {
        hostname: 'localhost',
        port: 8083,
        path: '/connectors',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        // 201 = created, 409 = already registered - both are success here.
        if (res.statusCode === 201 || res.statusCode === 409) {
          res.resume();
          resolve();
        } else {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            reject(
              new Error(`Connector register failed: ${res.statusCode} ${body}`),
            ),
          );
        }
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Order saga (e2e, full local stack)', () => {
  let orderDb: Client;
  let catalogToken: string;

  beforeAll(async () => {
    execSync(`docker compose up -d ${INFRA_SERVICES.join(' ')}`, {
      cwd: ROOT,
      stdio: 'inherit',
    });

    await waitUntil(
      async () => HEALTHY_CONTAINERS.every(isContainerHealthy),
      120_000,
    );

    await waitUntil(async () => {
      try {
        await registerOutboxConnector();
        return true;
      } catch {
        return false;
      }
    }, 60_000);

    for (const { name, port } of APP_SERVICES) {
      if (await isPortHealthy(port)) {
        continue; // already running (e.g. developer has it up via yarn start:dev)
      }
      const child = spawn('yarn', ['start:dev'], {
        cwd: `${ROOT}/${name}`,
        detached: true,
        stdio: 'ignore',
      });
      spawnedProcesses.push(child);
    }

    await Promise.all(
      APP_SERVICES.map(({ port }) =>
        waitUntil(() => isPortHealthy(port), 90_000),
      ),
    );

    orderDb = new Client({
      host: 'localhost',
      port: 5435,
      user: 'postgres',
      password: 'postgres',
      database: 'order_db',
    });
    await orderDb.connect();

    catalogToken = new JwtService({ secret: JWT_SECRET }).sign({
      sub: 'e2e-test',
      email: 'e2e@test.com',
      roles: ['customer'],
    });
  }, 180_000);

  afterAll(async () => {
    await orderDb?.end();
    // Only kill processes this test itself spawned - never touch a
    // developer's already-running yarn start:dev session, and never tear
    // down the shared docker-compose infra other work may depend on.
    for (const child of spawnedProcesses) {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    }
  });

  it('creates an order priced from catalog (not the client) and drives it to a terminal saga status', async () => {
    const productId = `e2e-product-${Date.now()}`;
    const createProduct = await httpPost(
      'http://localhost:3005/products',
      { productId, name: 'E2E product', price: 77 },
      { Authorization: `Bearer ${catalogToken}` },
    );
    expect(createProduct.status).toBe(201);

    const createOrder = await httpPost(
      'http://localhost:3001/orders',
      {
        customerId: 'e2e-customer',
        items: [{ productId, quantity: 3, price: 1 }], // fake low price
      },
      { Authorization: `Bearer ${catalogToken}` },
    );
    expect(createOrder.status).toBe(201);
    const order = JSON.parse(createOrder.body);

    // 3 * catalog price (77), not 3 * the client's fake price (1).
    expect(order.total).toBe(231);

    await waitUntil(async () => {
      const { rows } = await orderDb.query(
        'SELECT status FROM orders WHERE id = $1',
        [order.id],
      );
      return rows[0]?.status === 'COMPLETED' || rows[0]?.status === 'CANCELLED';
    }, 30_000);

    const { rows } = await orderDb.query(
      'SELECT status, total FROM orders WHERE id = $1',
      [order.id],
    );
    expect(['COMPLETED', 'CANCELLED']).toContain(rows[0].status);
    expect(Number(rows[0].total)).toBe(231);
  });
});
