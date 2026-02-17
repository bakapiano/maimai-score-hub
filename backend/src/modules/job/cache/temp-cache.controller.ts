import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  TempCacheBodySchema,
  TempCachePathSchema,
  type TempCacheBody,
  type TempCachePath,
} from '@maimai-score-hub/shared';

import { JobTempCacheService } from './temp-cache.service';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

@Controller('job')
export class TempCacheController {
  constructor(private readonly tempCache: JobTempCacheService) {}

  /**
   * 获取临时缓存的 FriendVS HTML
   */
  @Get(':jobId/cache/:diff/:type')
  async getCache(
    @Param(new ZodValidationPipe(TempCachePathSchema)) params: TempCachePath,
  ) {
    const html = await this.tempCache.get(params.jobId, params.diff, params.type);
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
    @Param(new ZodValidationPipe(TempCachePathSchema)) params: TempCachePath,
    @Body(new ZodValidationPipe(TempCacheBodySchema)) body: TempCacheBody,
  ) {
    await this.tempCache.set(params.jobId, params.diff, params.type, body.html);
    return { success: true };
  }
}
