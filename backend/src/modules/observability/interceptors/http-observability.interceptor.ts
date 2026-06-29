import {
  Injectable,
  NestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { finalize, tap } from 'rxjs';

import { ObservabilityIngestService } from '../services/observability-ingest.service';

type AuthedRequest = Request & {
  user?: { friendCode?: string };
};

@Injectable()
export class HttpObservabilityInterceptor implements NestInterceptor {
  constructor(private readonly ingest: ObservabilityIngestService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();
    let errorClass = '';

    return next.handle().pipe(
      tap({
        error: (err: unknown) => {
          errorClass = getErrorClass(err);
        },
      }),
      finalize(() => {
        const path = request.originalUrl || request.url || '';
        if (shouldSkip(path)) {
          return;
        }
        this.ingest.recordHttpRequest({
          method: request.method,
          routeTemplate: getRouteTemplate(request),
          statusCode: response.statusCode,
          durationMs: performance.now() - startedAt,
          requestBytes: parseContentLength(request.headers['content-length']),
          responseBytes: parseContentLength(
            response.getHeader('content-length'),
          ),
          friendCode: request.user?.friendCode ?? null,
          ipHash: hashValue(getClientIp(request)),
          userAgentHash: hashValue(request.headers['user-agent']),
          errorClass,
          traceId: getHeader(request, 'x-trace-id'),
          requestId: getHeader(request, 'x-request-id') || randomUUID(),
        });
      }),
    );
  }
}

function shouldSkip(path: string): boolean {
  return (
    path.includes('/observability/') ||
    path.includes('/swagger') ||
    path.endsWith('/health')
  );
}

function getRouteTemplate(request: AuthedRequest): string {
  const routePath = getExpressRoutePath(request);
  if (typeof routePath === 'string' && routePath) {
    const baseUrl = request.baseUrl || '';
    return `${baseUrl}${routePath}`.replace(/^\/api\/v1/, '/api/v1');
  }
  const path = (request.originalUrl || request.url || '').split('?')[0] || '/';
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\b\d{9,}\b/g, ':id');
}

function getExpressRoutePath(request: Request): string {
  const route = (request as { route?: unknown }).route;
  if (!route || typeof route !== 'object') {
    return '';
  }
  const path = (route as { path?: unknown }).path;
  return typeof path === 'string' ? path : '';
}

function parseContentLength(value: unknown): number | null {
  const raw = Array.isArray(value) ? (value[0] as unknown) : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function getHeader(request: Request, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) ? (value[0] ?? '') : '';
}

function getClientIp(request: Request): string {
  const forwarded = getHeader(request, 'x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? '';
  }
  return request.ip || request.socket.remoteAddress || '';
}

function hashValue(value: unknown): string {
  const raw = Array.isArray(value) ? (value[0] as unknown) : value;
  if (typeof raw !== 'string' || raw.length === 0) {
    return '';
  }
  return createHash('sha256').update(raw).digest('hex');
}

function getErrorClass(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return '';
  }
  const named = err as {
    name?: unknown;
    constructor?: { name?: unknown };
  };
  return typeof named.name === 'string'
    ? named.name
    : typeof named.constructor?.name === 'string'
      ? named.constructor.name
      : 'Error';
}
