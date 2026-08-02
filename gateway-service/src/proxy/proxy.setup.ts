import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const logger = new Logger('ProxySetup');

/**
 * Single entry point for all client traffic: reverse-proxies each path
 * prefix to the matching internal service. auth-service and order-service
 * already expose their real routes under /auth and /orders respectively,
 * so those two are forwarded unchanged; payment-service and
 * inventory-service only expose /health and /metrics today (their business
 * logic is RabbitMQ-driven, not HTTP), so /payments and /inventory strip
 * their prefix before forwarding.
 *
 * Each proxy is mounted with app.use(middleware) (no path argument) and
 * uses its own pathFilter instead of Express's path-prefix mounting —
 * app.use('/auth', middleware) makes Express strip '/auth' from req.url
 * before the middleware ever sees it, which breaks forwarding to services
 * whose own routes still expect that prefix (auth-service, order-service).
 */
// Bounds how long the gateway waits on a downstream service: `timeout`
// caps idle/connect time, `proxyTimeout` caps total time waiting for a
// response - http-proxy treats them separately so both need setting.
// Kept above the internal RPC timeouts deeper in the call chain
// (order-service's CATALOG_RPC_TIMEOUT_MS/INVENTORY_RPC_TIMEOUT_MS) so
// the gateway doesn't sever the connection before an internal circuit
// breaker/timeout has a chance to resolve first. Without this, a hung
// downstream would hold the gateway's connection open indefinitely.
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 15_000);

export function setupProxies(app: NestExpressApplication) {
  const targets = {
    auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3004',
    orders: process.env.ORDER_SERVICE_URL || 'http://localhost:3001',
    payments: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3002',
    inventory: process.env.INVENTORY_SERVICE_URL || 'http://localhost:3003',
    catalog: process.env.CATALOG_SERVICE_URL || 'http://localhost:3005',
  };

  app.use(
    createProxyMiddleware({
      pathFilter: (path) => path.startsWith('/auth'),
      target: targets.auth,
      changeOrigin: true,
      timeout: PROXY_TIMEOUT_MS,
      proxyTimeout: PROXY_TIMEOUT_MS,
    }),
  );
  app.use(
    createProxyMiddleware({
      pathFilter: (path) => path.startsWith('/orders'),
      target: targets.orders,
      changeOrigin: true,
      timeout: PROXY_TIMEOUT_MS,
      proxyTimeout: PROXY_TIMEOUT_MS,
    }),
  );
  app.use(
    createProxyMiddleware({
      pathFilter: (path) => path.startsWith('/payments'),
      target: targets.payments,
      changeOrigin: true,
      pathRewrite: { '^/payments': '' },
      timeout: PROXY_TIMEOUT_MS,
      proxyTimeout: PROXY_TIMEOUT_MS,
    }),
  );
  app.use(
    createProxyMiddleware({
      pathFilter: (path) => path.startsWith('/inventory'),
      target: targets.inventory,
      changeOrigin: true,
      pathRewrite: { '^/inventory': '' },
      timeout: PROXY_TIMEOUT_MS,
      proxyTimeout: PROXY_TIMEOUT_MS,
    }),
  );

  app.use(
    createProxyMiddleware({
      pathFilter: (path) => path.startsWith('/products'),
      target: targets.catalog,
      changeOrigin: true,
      timeout: PROXY_TIMEOUT_MS,
      proxyTimeout: PROXY_TIMEOUT_MS,
    }),
  );

  logger.log(`Proxying /auth -> ${targets.auth}`);
  logger.log(`Proxying /orders -> ${targets.orders}`);
  logger.log(`Proxying /payments -> ${targets.payments} (prefix stripped)`);
  logger.log(`Proxying /inventory -> ${targets.inventory} (prefix stripped)`);
  logger.log(`Proxying /products -> ${targets.catalog}`);
}
