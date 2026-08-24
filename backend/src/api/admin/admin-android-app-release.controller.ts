import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AndroidAppReleaseService } from '../../modules/android-app-release/services/android-app-release.service';

@Controller('admin/android/app/releases')
@UseGuards(SharedSecretGuard)
export class AdminAndroidAppReleaseController {
  constructor(private readonly releases: AndroidAppReleaseService) {}

  @Put('policies/:channel')
  async upsertPolicy(@Param('channel') channel: string, @Body() body: unknown) {
    return {
      ok: true,
      policy: await this.releases.upsertPolicy(channel, body),
    };
  }

  @Put(':releaseId/apk')
  async uploadApk(
    @Param('releaseId') releaseId: string,
    @Headers('content-length') rawContentLength: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: Request,
  ) {
    if (
      contentType?.split(';', 1)[0].trim() !==
        'application/vnd.android.package-archive' &&
      contentType?.split(';', 1)[0].trim() !== 'application/octet-stream'
    ) {
      throw new BadRequestException(
        'Android APK upload content type is invalid',
      );
    }
    const parsedLength = rawContentLength ? Number(rawContentLength) : null;
    if (
      parsedLength !== null &&
      (!Number.isFinite(parsedLength) || parsedLength < 0)
    ) {
      throw new BadRequestException('Android APK content length is invalid');
    }
    const apk = await this.releases.uploadApk(releaseId, request, parsedLength);
    return {
      ok: true,
      apkUrl: apk.apkUrl,
      apkSize: apk.size,
      apkSha256: apk.sha256,
    };
  }

  @Put(':releaseId')
  async publish(@Param('releaseId') releaseId: string, @Body() body: unknown) {
    return {
      ok: true,
      release: await this.releases.publish(releaseId, body),
    };
  }

  @Delete(':releaseId')
  async revoke(@Param('releaseId') releaseId: string) {
    await this.releases.revoke(releaseId);
    return { ok: true };
  }
}
