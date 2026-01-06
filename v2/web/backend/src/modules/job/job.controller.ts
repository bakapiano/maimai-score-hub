import {
  BadRequestException,
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

import { JobService } from './job.service';

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
  async patch(@Param('jobId') jobId: string, @Body() body: any) {
    return this.jobs.patch(jobId, body);
  }
}
