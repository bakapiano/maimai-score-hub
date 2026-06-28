import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

export const API_SHARED_SECRET_ENV = 'API_SHARED_SECRET';
export const API_SHARED_SECRET_HEADER = 'x-api-secret';
export const LEGACY_ADMIN_PASSWORD_ENV = 'ADMIN_PASSWORD';

@Injectable()
export class SharedSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredSecret =
      this.config.get<string>(API_SHARED_SECRET_ENV) ||
      this.config.get<string>(LEGACY_ADMIN_PASSWORD_ENV);
    if (!configuredSecret) {
      throw new UnauthorizedException('API shared secret is not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const rawHeader: unknown =
      req.headers[API_SHARED_SECRET_HEADER] ?? req.headers['X-API-Secret'];
    const providedSecret: unknown = Array.isArray(rawHeader)
      ? (rawHeader as unknown[])[0]
      : rawHeader;

    if (typeof providedSecret !== 'string' || providedSecret.length === 0) {
      throw new UnauthorizedException('Missing API shared secret');
    }

    if (!safeEqual(providedSecret, configuredSecret)) {
      throw new UnauthorizedException('Invalid API shared secret');
    }

    return true;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
