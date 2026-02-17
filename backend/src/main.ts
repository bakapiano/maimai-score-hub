import { json, urlencoded } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AddressInfo } from 'net';
import { AppModule } from './app.module';
import { NestFactory } from '@nestjs/core';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Match the legacy job-service payload size expectations (job result can be large)
  app.use(json({ limit: '100mb' }));
  app.use(urlencoded({ extended: true, limit: '100mb' }));
  app.enableCors({ origin: true });
  app.setGlobalPrefix('api');

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
