import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  SdgbJobNextBodySchema,
  SdgbJobPatchBodySchema,
  type SdgbJobNextBody,
  type SdgbJobPatchBody,
} from '@maimai-score-hub/shared';

import { WorkerAuthGuard } from '../../common/guards/worker-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbJobService } from './sdgb-job.service';

/**
 * HTTP surface that the standalone sdgb-worker polls. Guarded by
 * WorkerAuthGuard (X-Admin-Password). Falls open when ADMIN_PASSWORD
 * env is unset on the backend so local dev keeps working.
 *
 * Producers (CabinetService, AutoUpdateScheduler, ...) MUST go through
 * SdgbJobService.enqueue, never through these HTTP endpoints.
 */
@Controller('workers/sdgb/jobs')
@UseGuards(WorkerAuthGuard)
export class SdgbJobController {
  constructor(private readonly jobs: SdgbJobService) {}

  @Post('next')
  @HttpCode(200)
  async next(
    @Res() res: Response,
    @Body(new ZodValidationPipe(SdgbJobNextBodySchema)) body: SdgbJobNextBody,
  ) {
    const job = await this.jobs.claimNext(body.workerId);
    if (!job) {
      res.status(204).send();
      return;
    }
    res.json(job);
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
