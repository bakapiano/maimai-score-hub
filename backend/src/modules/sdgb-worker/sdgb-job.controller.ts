import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  SdgbJobNextBodySchema,
  SdgbJobPatchBodySchema,
  type SdgbJobNextBody,
  type SdgbJobPatchBody,
} from '@maimai-score-hub/shared';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbJobService } from './sdgb-job.service';

/**
 * HTTP surface that the standalone sdgb-worker polls. Only the worker should
 * hit these — there is no auth guard yet because the existing dxnet
 * /api/job/next isn't guarded either; both rely on network-level isolation.
 *
 * Producers (CabinetService, AutoUpdateScheduler, ...) MUST go through
 * SdgbJobService.enqueue, never through these HTTP endpoints.
 */
@Controller('sdgb-job')
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
