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
  type SdgbJobPatchBody,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbJobService } from '../../modules/sdgb-worker/services/sdgb-job.service';

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
  constructor(private readonly jobs: SdgbJobService) {}

  @Post('heartbeat')
  async heartbeat(
    @Body() body: { workerId?: unknown; claimedDelta?: unknown },
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
    await this.jobs.reportWorkerStatus(workerId, claimedDelta);
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
    return this.jobs.patch(jobId, body);
  }
}
