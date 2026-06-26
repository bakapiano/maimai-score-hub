import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  TempCacheBodySchema,
  TempCachePathSchema,
  type TempCacheBody,
  type TempCachePath,
} from '@maimai-score-hub/shared';

import { JobTempCacheService } from '../../modules/job/cache/temp-cache.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('workers/dxnet/jobs')
@UseGuards(SharedSecretGuard)
export class WorkerDxnetTempCacheController {
  constructor(private readonly tempCache: JobTempCacheService) {}

  /**
   * 获取临时缓存的 FriendVS 解析结果
   */
  @Get(':jobId/cache/:diff/:type')
  async getCache(
    @Param(new ZodValidationPipe(TempCachePathSchema)) params: TempCachePath,
  ) {
    const songs = await this.tempCache.get(
      params.jobId,
      params.diff,
      params.type,
    );
    if (!songs) {
      throw new BadRequestException('Cache not found');
    }

    return { songs };
  }

  /**
   * 设置临时缓存
   */
  @Put(':jobId/cache/:diff/:type')
  @HttpCode(201)
  async setCache(
    @Param(new ZodValidationPipe(TempCachePathSchema)) params: TempCachePath,
    @Body(new ZodValidationPipe(TempCacheBodySchema)) body: TempCacheBody,
  ) {
    await this.tempCache.set(
      params.jobId,
      params.diff,
      params.type,
      body.songs,
    );
    return { success: true };
  }
}
