import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  JobCreateBodySchema,
  type JobCreateBody,
} from '@maimai-score-hub/shared';

import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { JobFriendshipService } from '../../modules/job/services/job-friendship.service';
import { JobService } from '../../modules/job/services/job.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

@Controller('me/dxnet-jobs')
@UseGuards(AuthGuard)
export class MeDxnetJobsController {
  constructor(
    private readonly jobs: JobService,
    private readonly friendship: JobFriendshipService,
  ) {}

  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(JobCreateBodySchema)) body: JobCreateBody,
  ) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }

    return this.jobs.create({
      friendCode,
      jobType: body.jobType,
      friendshipJobId: body.friendshipJobId,
    });
  }

  @Get('active')
  async getActive(@Req() req: AuthedRequest) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }
    const job = await this.jobs.getActiveByFriendCode(friendCode);
    return { job };
  }

  @Get('friendship')
  async getFriendshipStatus(@Req() req: AuthedRequest) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }
    return this.friendship.getFriendshipStatus(friendCode);
  }

  @Get(':jobId')
  async get(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }

    const job = await this.jobs.get(jobId);
    if (job.friendCode !== friendCode) {
      throw new BadRequestException('Cannot get jobs for other users');
    }

    return job;
  }

  @Post(':jobId/verify')
  @HttpCode(200)
  async verify(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }

    const job = await this.jobs.get(jobId);
    if (job.friendCode !== friendCode) {
      throw new BadRequestException('Cannot verify jobs for other users');
    }

    return { job: await this.jobs.wake(jobId) };
  }
}
