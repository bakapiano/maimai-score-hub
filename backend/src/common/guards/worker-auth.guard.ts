import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Auth guard for backend endpoints called by the dxnet worker and
 * sdgb-worker. Same shared-secret model as `AdminGuard`: clients send
 * the secret in the `X-Admin-Password` header.
 *
 * **Soft-fail by design**: when `ADMIN_PASSWORD` is unset the guard
 * lets every request through. This mirrors how worker code injects
 * the header — it only adds the header if its own ADMIN_PASSWORD env
 * is set. The combination keeps local dev (no secret anywhere) and
 * partial-rollout deploys (some hosts updated, some not) working
 * without 401 storms.
 *
 * Once every host has the secret pinned, you can flip this to hard-
 * fail by removing the early-return on missing config.
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const adminPassword = this.config.get<string>('ADMIN_PASSWORD');
    if (!adminPassword) {
      // Server has no secret configured — fall through to the legacy
      // unauthenticated behaviour. Logged via NestJS startup banner
      // (the guard doesn't itself spam per-request).
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const header: unknown =
      req.headers['x-admin-password'] ?? req.headers['X-Admin-Password'];

    if (typeof header !== 'string' || header !== adminPassword) {
      throw new UnauthorizedException('Worker auth failed');
    }
    return true;
  }
}
