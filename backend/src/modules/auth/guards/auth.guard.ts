import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthService, type AuthTokenPayload } from '../services/auth.service';

type AuthedRequest = Request & {
  user?: AuthTokenPayload;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const rawHeader: unknown =
      req.headers['authorization'] || req.headers['Authorization'];
    const header: unknown = Array.isArray(rawHeader)
      ? (rawHeader as unknown[])[0]
      : rawHeader;
    if (
      !header ||
      typeof header !== 'string' ||
      !header.toLowerCase().startsWith('bearer ')
    ) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice(7).trim();
    const payload = this.auth.verifyToken(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    req.user = payload;

    // Fire-and-forget: update last active time
    if (payload.sub) {
      this.auth.updateLastActiveAt(payload.sub);
    }

    return true;
  }
}
