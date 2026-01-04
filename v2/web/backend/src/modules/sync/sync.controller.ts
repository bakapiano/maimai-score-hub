import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { SyncService } from './sync.service';
import { UsersService } from '../users/users.service';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

function requireFriendCode(req: AuthedRequest): string {
  const friendCode = req.user?.friendCode;
  if (!friendCode) {
    throw new BadRequestException('Missing friendCode in token');
  }
  return friendCode;
}

function requireUserId(req: AuthedRequest): string {
  const userId = req.user?.sub;
  if (!userId) {
    throw new BadRequestException('Missing user context');
  }
  return userId;
}

@Controller('sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(
    private readonly syncs: SyncService,
    private readonly users: UsersService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    return this.syncs.listByFriendCode(friendCode);
  }

  @Get(':id')
  async detail(@Param('id') id: string, @Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    return this.syncs.getWithScores(id, friendCode);
  }

  @Post(':id/diving-fish')
  async exportToDivingFish(@Param('id') id: string, @Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    const userId = requireUserId(req);

    const user = await this.users.getById(userId);
    const token = user?.divingFishImportToken;
    if (!token) {
      throw new BadRequestException('User missing divingFishImportToken');
    }

    return this.syncs.exportToDivingFish(id, friendCode, token);
  }

  @Post(':id/lxns')
  async exportToLxns(@Param('id') id: string, @Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    const userId = requireUserId(req);

    const user = await this.users.getById(userId);
    const token = user?.lxnsImportToken;
    if (!token) {
      throw new BadRequestException('User missing lxnsImportToken');
    }

    return this.syncs.exportToLxns(id, friendCode, token);
  }
}
