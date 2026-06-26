import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
