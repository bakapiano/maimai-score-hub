import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { ProberExportService } from '../../modules/prober-export/services/prober-export.service';
import { SyncService } from '../../modules/sync/services/sync.service';
import { UsersService } from '../../modules/users/services/users.service';

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

@Controller('me/sync')
@UseGuards(AuthGuard)
export class MeSyncController {
  constructor(
    private readonly syncs: SyncService,
    private readonly users: UsersService,
    private readonly proberExports: ProberExportService,
  ) {}

  @Get('latest')
  async latest(@Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    return this.syncs.getLatestWithScores(friendCode);
  }

  @Post('latest/exports/diving-fish')
  async exportToDivingFish(@Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    const userId = requireUserId(req);

    const user = await this.users.getById(userId);
    const token = user?.divingFishImportToken;
    if (!token) {
      throw new BadRequestException('User missing divingFishImportToken');
    }

    const syncId = await this.syncs.getLatestSyncId(friendCode);
    const job = await this.proberExports.enqueueManualExport({
      friendCode,
      syncId,
      target: 'divingFish',
    });
    return { exportJobId: job.id, status: job.status, job };
  }

  @Post('latest/exports/lxns')
  async exportToLxns(@Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    const userId = requireUserId(req);

    const user = await this.users.getById(userId);
    const token = user?.lxnsImportToken;
    if (!token) {
      throw new BadRequestException('User missing lxnsImportToken');
    }

    const syncId = await this.syncs.getLatestSyncId(friendCode);
    const job = await this.proberExports.enqueueManualExport({
      friendCode,
      syncId,
      target: 'lxns',
    });
    return { exportJobId: job.id, status: job.status, job };
  }

  @Get('prober-export-jobs/:exportJobId')
  async getProberExportJob(
    @Req() req: AuthedRequest,
    @Param('exportJobId') exportJobId: string,
  ) {
    const friendCode = requireFriendCode(req);
    return this.proberExports.getForUser(exportJobId, friendCode);
  }

  @Get('prober-export-jobs')
  async listProberExportJobs(
    @Req() req: AuthedRequest,
    @Query('limit') limitRaw?: string,
  ) {
    const friendCode = requireFriendCode(req);
    const limit = limitRaw ? Number(limitRaw) : 20;
    const items = await this.proberExports.getRecentForUser(
      friendCode,
      Number.isFinite(limit) ? limit : 20,
    );
    return { items };
  }
}
