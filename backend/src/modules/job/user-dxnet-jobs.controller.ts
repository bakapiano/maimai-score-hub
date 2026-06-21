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

import { AuthGuard } from '../auth/auth.guard';
import { JobService } from './job.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

@Controller('me/dxnet-jobs')
@UseGuards(AuthGuard)
export class UserDxnetJobsController {
  constructor(private readonly jobs: JobService) {}

  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(JobCreateBodySchema)) body: JobCreateBody,
  ) {
    // 只能为自己的好友码创建任务
    if (req.user?.friendCode !== body.friendCode) {
      throw new BadRequestException('Cannot create jobs for other users');
    }

    return this.jobs.create({
      friendCode: body.friendCode,
      skipUpdateScore: body.skipUpdateScore,
      jobType: 'update_score',
      isAuthenticated: true,
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

  @Post(':jobId/wake')
  @HttpCode(200)
  async wake(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }

    const job = await this.jobs.get(jobId);
    if (job.friendCode !== friendCode) {
      throw new BadRequestException('Cannot wake jobs for other users');
    }

    return { job: await this.jobs.wake(jobId) };
  }
}
