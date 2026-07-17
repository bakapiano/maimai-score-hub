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
  SdgbWorkerHeartbeatSchema,
  type SdgbJobPatchBody,
  type SdgbWorkerHeartbeat,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbJobService } from '../../modules/sdgb-worker/services/sdgb-job.service';
import { CabinetScoreSyncService } from '../../modules/cabinet-score-sync/cabinet-score-sync.service';
import { SdgbWorkerRegistryService } from '../../modules/sdgb-worker/services/sdgb-worker-registry.service';

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
    private readonly registry: SdgbWorkerRegistryService,
  ) {}

  @Post('heartbeat')
  async heartbeat(
    @Body(new ZodValidationPipe(SdgbWorkerHeartbeatSchema))
    body: SdgbWorkerHeartbeat,
  ) {
    return this.registry.heartbeat(body);
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
