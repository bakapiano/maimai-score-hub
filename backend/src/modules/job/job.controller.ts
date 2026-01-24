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

import { AuthGuard } from '../auth/auth.guard';
import { JobService } from './job.service';
import type { JobPatchBody } from './job.types';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

@Controller('job')
export class JobController {
  constructor(private readonly jobs: JobService) {}

  @Post('create')
  async create(
    @Body() body: { friendCode?: unknown; skipUpdateScore?: unknown },
  ) {
    if (typeof body.friendCode !== 'string' || !body.friendCode) {
      throw new BadRequestException('friendCode is required');
    }

    if (
      body.skipUpdateScore !== undefined &&
      typeof body.skipUpdateScore !== 'boolean'
    ) {
      throw new BadRequestException('skipUpdateScore must be a boolean');
    }

    return this.jobs.create({
      friendCode: body.friendCode,
      skipUpdateScore: (body.skipUpdateScore as boolean | undefined) ?? false,
    });
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
    @Body() body: { botUserFriendCode?: unknown },
  ) {
    if (typeof body.botUserFriendCode !== 'string' || !body.botUserFriendCode) {
      throw new BadRequestException('botUserFriendCode is required');
    }

    const job = await this.jobs.claimNext(body.botUserFriendCode);
    if (!job) {
      res.status(204).send();
      return;
    }

    res.json(job);
  }

  @Patch(':jobId')
  async patch(@Param('jobId') jobId: string, @Body() body: JobPatchBody) {
    return this.jobs.patch(jobId, body);
  }
}
