import './tracer';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { setupProxies } from './proxy/proxy.setup';

async function bootstrap() {
  // bodyParser: false - http-proxy-middleware needs the raw, unconsumed
  // request stream to forward POST/PUT bodies; Nest's default global body
  // parser would read the stream first and leave nothing to proxy.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
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
    }),
  );

  setupProxies(app);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
