import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ManualScoreUpdateBodySchema,
  type ManualScoreUpdateBody,
} from '@maimai-score-hub/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
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
  private readonly logger = new Logger(MeSyncController.name);

  constructor(
    private readonly syncs: SyncService,
    private readonly users: UsersService,
    private readonly proberExports: ProberExportService,
  ) {}

  @Get('latest')
  async latest(@Req() req: AuthedRequest) {
    const friendCode = requireFriendCode(req);
    const [sync, proberExportState] = await Promise.all([
      this.syncs.getLatestWithScores(friendCode),
      this.proberExports.getStateForUser(friendCode),
    ]);
    return {
      ...sync,
      proberExportState,
      autoExportResult: proberExportState
        ? {
            divingFish: this.toLegacyExportMirror(
              proberExportState.providers.divingFish,
              sync.scoreVersion,
            ),
            lxns: this.toLegacyExportMirror(
              proberExportState.providers.lxns,
              sync.scoreVersion,
            ),
          }
        : null,
    };
  }

  @Post('scores')
  @HttpCode(200)
  async updateScores(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(ManualScoreUpdateBodySchema))
    body: ManualScoreUpdateBody,
  ) {
    const tokenFriendCode = requireFriendCode(req);
    const ownerUserId = requireUserId(req);
    const user = await this.users.getById(ownerUserId);
    if (user.friendCode !== tokenFriendCode) {
      throw new UnauthorizedException('User context mismatch');
    }
    const friendCode = user.friendCode;
    const result = await this.syncs.createFromManualScores({
      friendCode,
      ownerUserId,
      scores: body.scores,
    });
    if (result.changedChartCount > 0) {
      void this.proberExports
        .ensureAutoExportWake(friendCode)
        .catch((error) =>
          this.logger.warn(
            `manual score auto-export wake failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
    return result;
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

  private toLegacyExportMirror(
    provider: {
      enabled: boolean;
      lastSuccessVersion: number | null;
      status: 'idle' | 'processing' | 'failed';
      error: string | null;
    },
    currentScoreVersion: number,
  ) {
    if (!provider.enabled) {
      return null;
    }
    if (provider.status === 'failed') {
      return { status: 'failed', message: provider.error ?? undefined };
    }
    if (provider.status === 'processing') {
      return { status: 'processing' };
    }
    return provider.lastSuccessVersion === null ||
      provider.lastSuccessVersion < currentScoreVersion
      ? { status: 'pending' }
      : { status: 'success' };
  }
}
