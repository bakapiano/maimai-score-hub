import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  JobCreateBodySchema,
  JobNextBodySchema,
  JobPatchBodySchema,
  type JobCreateBody,
  type JobNextBody,
} from '@maimai-score-hub/shared';

import { AuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JobService } from './job.service';
import { UsersService } from '../users/users.service';
import type { JobPatchBody } from './job.types';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

@Controller('job')
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly users: UsersService,
  ) {}

  @Post('create')
  @UseGuards(AuthGuard)
  async create(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(JobCreateBodySchema)) body: JobCreateBody,
  ) {
    // 只能为自己的好友码创建任务
    if (req.user?.friendCode !== body.friendCode) {
      throw new BadRequestException('Cannot create jobs for other users');
    }

    const result = await this.jobs.create({
      friendCode: body.friendCode,
      skipUpdateScore: body.skipUpdateScore,
      fullSync: body.fullSync,
      isAuthenticated: true,
    });

    // 立即更新时，如果用户已开启闲时更新，则自动取消闲时更新
    const user = await this.users.findByFriendCode(body.friendCode);
    if (user && user.idleUpdateBotFriendCode) {
      await this.users.update(String(user._id), {
        idleUpdateBotFriendCode: null,
      });
    }

    return result;
  }

  @Get('stats/recent')
  async getRecentStats() {
    return this.jobs.getRecentStats();
  }

  @Get('by-friend-code/:friendCode/active')
  @UseGuards(AuthGuard)
  async getActiveByFriendCode(
    @Param('friendCode') friendCode: string,
    @Req() req: AuthedRequest,
  ) {
    // 只能查询自己的任务
    if (req.user?.friendCode !== friendCode) {
      throw new BadRequestException('Cannot access jobs for other users');
    }
    const job = await this.jobs.getActiveByFriendCode(friendCode);
    return { job };
  }

  @Get('active/:botUserFriendCode')
  async getActiveFriendCodes(
    @Param('botUserFriendCode') botUserFriendCode: string,
  ) {
    return this.jobs.getActiveFriendCodesByBot(botUserFriendCode);
  }

  @Get(':jobId')
  async get(@Param('jobId') jobId: string) {
    return this.jobs.get(jobId);
  }

  @Post('next')
  @HttpCode(200)
  async next(
    @Res() res: Response,
    @Body(new ZodValidationPipe(JobNextBodySchema)) body: JobNextBody,
  ) {
    const job = await this.jobs.claimNext(body.botUserFriendCode);
    if (!job) {
      res.status(204).send();
      return;
    }

    res.json(job);
  }

  @Patch(':jobId')
  async patch(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(JobPatchBodySchema)) body: JobPatchBody,
  ) {
    return this.jobs.patch(jobId, body);
  }
}
