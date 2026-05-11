import { existsSync, readFileSync } from 'node:fs';
import { json, urlencoded } from 'express';

import { AddressInfo } from 'net';
import { AppModule } from './app.module';
import { NestFactory } from '@nestjs/core';
import { lookup as originalLookup } from 'node:dns';
import { parse } from 'yaml';
import { resolve } from 'node:path';
import swaggerUi from 'swagger-ui-express';

// Force IPv4-only DNS resolution globally.
// Docker's internal DNS (127.0.0.11) returns SERVFAIL for AAAA queries on
// some CDNs (e.g. maimai.wahlap.com), causing getaddrinfo to hang ~5s.
// `setDefaultResultOrder('ipv4first')` is insufficient because getaddrinfo
// with family=0 still queries AAAA and fails on SERVFAIL.
const _origLookup = originalLookup;
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('node:dns').lookup = function patchedLookup(
  hostname: string,
  options: unknown,
  callback: unknown,
) {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === 'number') {
    options = { family: 4, hints: options };
  } else if (options && typeof options === 'object') {
    options = { ...options, family: 4 };
  } else {
    options = { family: 4 };
  }
  return _origLookup.call(this, hostname, options as never, callback as never);
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Match the legacy job-service payload size expectations (job result can be large)
  app.use(json({ limit: '100mb' }));
  app.use(urlencoded({ extended: true, limit: '100mb' }));
  app.enableCors({ origin: true });
  app.setGlobalPrefix('api');
  // Graceful shutdown on SIGTERM (docker stop sends this).
  // Without this, in-flight requests get killed at the 10s SIGKILL
  // grace window, which shows up as RST/ECONNRESET on the client
  // during deploys.
  app.enableShutdownHooks();

  const openApiCandidates = [
    resolve(process.cwd(), '../shared/openapi/openapi.yaml'),
    resolve(__dirname, '../../shared/openapi/openapi.yaml'),
  ];
  const openApiPath = openApiCandidates.find((candidate) =>
    existsSync(candidate),
  );

  if (openApiPath) {
    const openApiYaml = readFileSync(openApiPath, 'utf8');
    const openApiDoc = parse(openApiYaml);
    app.use('/swagger', swaggerUi.serve, swaggerUi.setup(openApiDoc));
    console.log(`Swagger UI available at /swagger (source: ${openApiPath})`);
  } else {
    console.warn(
      'OpenAPI YAML not found, skipping Swagger UI. Run: npm --prefix ../shared run openapi:generate',
    );
  }

  const preferredPort = Number(process.env.PORT ?? 9050);
  const host = process.env.HOST ?? '0.0.0.0';
  const fallbackPort = Number(process.env.FALLBACK_PORT ?? 0) || 0; // 0 lets OS pick a free port

  try {
    await app.listen(preferredPort, host);
    const addr = app.getHttpServer().address() as AddressInfo;
    console.log(`Listening on ${addr.address}:${addr.port}`);
  } catch (err: any) {
    if (err?.code === 'EACCES' || err?.code === 'EADDRINUSE') {
      // Retry with a fallback (or random free port) instead of crashing on bind errors
      await app.listen(fallbackPort, host);
      const addr = app.getHttpServer().address() as AddressInfo;
      console.warn(
        `Port ${preferredPort} unavailable (${err?.code}); using ${addr.address}:${addr.port}`,
      );
      console.log(`Listening on ${addr.address}:${addr.port}`);
    } else {
      throw err;
    }
  }
}

bootstrap();
