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
import { JobTempCacheService } from './job-temp-cache.service';
import { JobApiLogService, type ApiLogEntry } from './job-api-log.service';
import { UsersService } from '../users/users.service';
import type { JobPatchBody } from './job.types';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

@Controller('job')
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly tempCache: JobTempCacheService,
    private readonly apiLog: JobApiLogService,
    private readonly users: UsersService,
  ) {}

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

  /**
   * Worker 调用：标记用户已 ready for 闲时更新
   */
  @Post('idle-update/mark-ready')
  @HttpCode(200)
  async markIdleUpdateReady(
    @Body() body: { friendCode?: unknown; botFriendCode?: unknown },
  ) {
    if (typeof body.friendCode !== 'string' || !body.friendCode) {
      throw new BadRequestException('friendCode is required');
    }
    if (typeof body.botFriendCode !== 'string' || !body.botFriendCode) {
      throw new BadRequestException('botFriendCode is required');
    }

    const user = await this.users.findByFriendCode(body.friendCode);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    await this.users.update(String(user._id), {
      idleUpdateBotFriendCode: body.botFriendCode,
    });

    return { ok: true };
  }

  /**
   * 获取指定 bot 的闲时更新 friendCode 列表
   */
  @Get('idle-update/friends/:botFriendCode')
  async getIdleUpdateFriendCodes(
    @Param('botFriendCode') botFriendCode: string,
  ) {
    const users = await this.users.getIdleUpdateUsers();
    return users
      .filter((u) => u.idleUpdateBotFriendCode === botFriendCode)
      .map((u) => u.friendCode);
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

  /**
   * 获取临时缓存的 FriendVS HTML
   */
  @Get(':jobId/cache/:diff/:type')
  async getCache(
    @Param('jobId') jobId: string,
    @Param('diff') diffStr: string,
    @Param('type') typeStr: string,
  ) {
    const diff = parseInt(diffStr, 10);
    const type = parseInt(typeStr, 10);

    if (Number.isNaN(diff) || Number.isNaN(type)) {
      throw new BadRequestException('Invalid diff or type');
    }

    const html = await this.tempCache.get(jobId, diff, type);
    if (!html) {
      throw new BadRequestException('Cache not found');
    }

    return { html };
  }

  /**
   * 设置临时缓存
   */
  @Post(':jobId/cache/:diff/:type')
  @HttpCode(201)
  async setCache(
    @Param('jobId') jobId: string,
    @Param('diff') diffStr: string,
    @Param('type') typeStr: string,
    @Body() body: { html?: unknown },
  ) {
    const diff = parseInt(diffStr, 10);
    const type = parseInt(typeStr, 10);

    if (Number.isNaN(diff) || Number.isNaN(type)) {
      throw new BadRequestException('Invalid diff or type');
    }

    if (typeof body.html !== 'string') {
      throw new BadRequestException('html must be a string');
    }

    await this.tempCache.set(jobId, diff, type, body.html);
    return { success: true };
  }

  /**
   * Worker 上报 API 调用日志
   */
  @Post(':jobId/api-logs')
  @HttpCode(201)
  async addApiLogs(
    @Param('jobId') jobId: string,
    @Body() body: { logs?: unknown },
  ) {
    if (!Array.isArray(body.logs)) {
      throw new BadRequestException('logs must be an array');
    }

    const logs: ApiLogEntry[] = [];
    for (let i = 0; i < body.logs.length; i++) {
      const entry = body.logs[i];
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof entry.url !== 'string' ||
        typeof entry.method !== 'string' ||
        typeof entry.statusCode !== 'number'
      ) {
        throw new BadRequestException(
          `Invalid log entry at index ${i}: url, method (string) and statusCode (number) are required`,
        );
      }
      logs.push({
        url: entry.url,
        method: entry.method,
        statusCode: entry.statusCode,
        responseBody:
          typeof entry.responseBody === 'string'
            ? entry.responseBody
            : null,
      });
    }

    await this.apiLog.saveLogs(jobId, logs);
    return { success: true };
  }
}
