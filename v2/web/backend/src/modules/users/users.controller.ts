import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';

type AuthedRequest = Request & { userId?: string };

function extractUserId(req: AuthedRequest): string | undefined {
  const typed = req as unknown as {
    user?: { sub?: unknown };
    userId?: unknown;
  };
  const candidate = typed.user?.sub ?? typed.userId;
  return typeof candidate === 'string' ? candidate : undefined;
}

@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('profile')
  async profile(@Req() req: AuthedRequest) {
    // AuthGuard populates req.user; also allow legacy req.userId
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    return this.users.getById(userId);
  }

  @Patch('profile')
  async updateProfile(
    @Req() req: AuthedRequest,
    @Body()
    body: { divingFishImportToken?: unknown; lxnsImportToken?: unknown },
  ) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    const divingFishToken = (() => {
      if (
        body.divingFishImportToken === undefined ||
        body.divingFishImportToken === null
      ) {
        return null;
      }
      if (typeof body.divingFishImportToken !== 'string') {
        throw new BadRequestException('divingFishImportToken must be a string');
      }
      return body.divingFishImportToken;
    })();

    const lxnsToken = (() => {
      if (body.lxnsImportToken === undefined || body.lxnsImportToken === null) {
        return null;
      }
      if (typeof body.lxnsImportToken !== 'string') {
        throw new BadRequestException('lxnsImportToken must be a string');
      }
      return body.lxnsImportToken;
    })();

    return this.users.update(userId, {
      divingFishImportToken: divingFishToken,
      lxnsImportToken: lxnsToken,
    });
  }
}
