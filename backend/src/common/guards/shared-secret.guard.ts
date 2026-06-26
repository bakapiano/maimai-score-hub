import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

export const API_SHARED_SECRET_ENV = 'API_SHARED_SECRET';
export const API_SHARED_SECRET_HEADER = 'x-api-secret';

@Injectable()
export class SharedSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredSecret = this.config.get<string>(API_SHARED_SECRET_ENV);
    if (!configuredSecret) {
      throw new UnauthorizedException('API shared secret is not configured');
    }

    const req = context.switchToHttp().getRequest();
    const rawHeader: unknown =
      req.headers[API_SHARED_SECRET_HEADER] ?? req.headers['X-API-Secret'];
    const providedSecret = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

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
