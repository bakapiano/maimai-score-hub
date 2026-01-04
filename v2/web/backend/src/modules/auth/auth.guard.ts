import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined =
      req.headers['authorization'] || req.headers['Authorization'];
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
    return true;
  }
}
