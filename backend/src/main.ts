import { existsSync, readFileSync } from 'node:fs';
import { json, urlencoded } from 'express';

import type { AddressInfo } from 'net';
import { AppModule } from './app.module';
import { BackendLoggerService } from './modules/observability/services/backend-logger.service';
import { NestFactory } from '@nestjs/core';
import * as dns from 'node:dns';
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
type DnsLookup = typeof originalLookup;
type HttpServerWithAddress = {
  address: () => AddressInfo | string | null;
};

(dns as { lookup: DnsLookup }).lookup = function patchedLookup(
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
  void _origLookup(hostname, options as never, callback as never);
} as DnsLookup;

function getHttpAddress(server: unknown): AddressInfo {
  const address = (server as HttpServerWithAddress).address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP server did not expose a TCP address');
  }
  return address;
}

function isRecoverableListenError(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err.code === 'EACCES' || err.code === 'EADDRINUSE')
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(BackendLoggerService));
  // Match the legacy job-service payload size expectations (job result can be large)
  app.use(json({ limit: '100mb' }));
  app.use(urlencoded({ extended: true, limit: '100mb' }));
  app.enableCors({ origin: true });
  app.setGlobalPrefix('api/v1');
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
    const openApiDoc = parse(openApiYaml) as Record<string, unknown>;
    app.use('/api/v1/swagger', swaggerUi.serve, swaggerUi.setup(openApiDoc));
    console.log(
      `Swagger UI available at /api/v1/swagger (source: ${openApiPath})`,
    );
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
    const addr = getHttpAddress(app.getHttpServer());
    console.log(`Listening on ${addr.address}:${addr.port}`);
  } catch (err: unknown) {
    if (isRecoverableListenError(err)) {
      // Retry with a fallback (or random free port) instead of crashing on bind errors
      await app.listen(fallbackPort, host);
      const addr = getHttpAddress(app.getHttpServer());
      console.warn(
        `Port ${preferredPort} unavailable (${err.code}); using ${addr.address}:${addr.port}`,
      );
      console.log(`Listening on ${addr.address}:${addr.port}`);
    } else {
      throw err;
    }
  }
}

void bootstrap();
