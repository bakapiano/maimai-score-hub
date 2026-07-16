import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  SdgbJobPatchBodySchema,
  isSdgbWorkerRole,
  type SdgbJobPatchBody,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbJobService } from '../../modules/sdgb-worker/services/sdgb-job.service';
import { CabinetScoreSyncService } from '../../modules/cabinet-score-sync/cabinet-score-sync.service';

/**
 * HTTP surface that the standalone sdgb-worker uses after BullMQ delivery. Guarded by
 * SharedSecretGuard (X-API-Secret), the same shared-secret auth used by
 * admin APIs.
 *
 * Producers (CabinetService, AutoUpdateScheduler, ...) MUST go through
 * SdgbJobService.enqueue, never through these HTTP endpoints.
 */
@Controller('workers/sdgb/jobs')
@UseGuards(SharedSecretGuard)
export class WorkerSdgbJobsController {
  constructor(
    private readonly jobs: SdgbJobService,
    private readonly cabinetScores: CabinetScoreSyncService,
  ) {}

  @Post('heartbeat')
  async heartbeat(
    @Body()
    body: {
      workerId?: unknown;
      claimedDelta?: unknown;
      role?: unknown;
    },
  ) {
    const workerId =
      typeof body.workerId === 'string' && body.workerId.trim()
        ? body.workerId.trim()
        : 'unknown';
    const claimedDelta =
      typeof body.claimedDelta === 'number' &&
      Number.isFinite(body.claimedDelta)
        ? Math.max(0, Math.floor(body.claimedDelta))
        : 0;
    const role = isSdgbWorkerRole(body.role) ? body.role : undefined;
    await this.jobs.reportWorkerStatus(workerId, claimedDelta, role);
    return { ok: true };
  }

  @Get(':jobId')
  async get(@Param('jobId') jobId: string) {
    return this.jobs.get(jobId);
  }

  @Patch(':jobId')
  async patch(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(SdgbJobPatchBodySchema)) body: SdgbJobPatchBody,
  ) {
    return this.cabinetScores.patchFromWorker(jobId, body);
  }
}
