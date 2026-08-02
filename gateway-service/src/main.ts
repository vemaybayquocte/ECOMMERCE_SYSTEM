import './tracer';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import { AppModule } from './app.module';
import { setupProxies } from './proxy/proxy.setup';

async function bootstrap() {
  // rate-limit-redis's RedisStore constructor fires off a SCRIPT LOAD
  // command immediately (fire-and-forget, not awaited - it's a
  // constructor). If that command rejects - Redis unreachable, or even
  // just not-yet-connected during normal startup - it's an unhandled
  // promise rejection, which crashes the whole process by default in
  // modern Node. Rate limiting must never be able to take the gateway
  // down, so this is caught here as a last-resort safety net alongside
  // the enableOfflineQueue fix below (which prevents the common case -
  // startup race - from ever reaching this path at all).
  process.on('unhandledRejection', (reason) => {
    console.error('[RateLimitRedis] unhandled rejection (ignored):', reason);
  });

  // bodyParser: false - http-proxy-middleware needs the raw, unconsumed
  // request stream to forward POST/PUT bodies; Nest's default global body
  // parser would read the stream first and leave nothing to proxy.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Backs the rate limiter below with a shared counter store: the gateway
  // runs multiple replicas, so express-rate-limit's default in-memory
  // store would let each pod enforce its own separate limit (effective
  // limit = THROTTLE_LIMIT * podCount) instead of one limit cluster-wide.
  // enableOfflineQueue defaults to true (NOT disabled here) so commands
  // issued before the connection finishes handshaking - including
  // RedisStore's own constructor calling SCRIPT LOAD synchronously below
  // - queue and flush once ready, instead of rejecting immediately and
  // crashing the app on every single startup.
  const redisClient = new Redis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
    {
      // ioredis's own default (20) meant a single rate-limit check during
      // a real Redis outage took ~20s to give up and fail open - fast
      // failure is the whole point of fail-open, a request that just
      // hangs for 20s before "succeeding" is barely better than a 500.
      // 2 was tried first and was too aggressive: it also counts against
      // commands queued during the brief, completely normal connection
      // handshake at pod startup (enableOfflineQueue queues them, but
      // maxRetriesPerRequest still caps how many connection-attempt
      // cycles a queued command waits through) - under any real system
      // load that handshake can take longer than 2 cycles, so requests
      // right after boot were failing open even though Redis was fine
      // and about to connect. 5 gives enough slack for a normal startup
      // race while still resolving in a few seconds during a genuine
      // outage, instead of the original ~20s.
      maxRetriesPerRequest: 5,
      retryStrategy: () => 1000,
      lazyConnect: false,
    },
  );
  redisClient.on('error', (err) => {
    // Rate limiting is not critical-path: log and let the store's own
    // fail-open handling (below) take over rather than crashing the
    // gateway over a Redis blip.
    console.error('[RateLimitRedis] connection error:', err.message);
  });

  // Plain Express middleware, not a Nest guard: the proxied paths
  // (/auth, /orders, /payments, /inventory) are forwarded by raw app.use()
  // middleware below and never pass through Nest's own routing/guard
  // pipeline, so a Nest APP_GUARD would silently never see that traffic.
  app.use(
    rateLimit({
      windowMs: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
      limit: Number(process.env.THROTTLE_LIMIT ?? 100),
      standardHeaders: true,
      legacyHeaders: false,
      // Fail-open: Redis backs a brand-new, non-critical component bolted
      // onto a path that had zero external dependencies before. If the
      // store throws (Redis unreachable), let the request pass unlimited
      // rather than 500ing every proxied request over a rate-limiter
      // outage.
      passOnStoreError: true,
      store: new RedisStore({
        sendCommand: (...args: string[]) =>
          (
            redisClient.call as (
              ...cmdArgs: string[]
            ) => Promise<string | number | Array<string | number> | null>
          )(...args),
      }),
    }),
  );

  setupProxies(app);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
