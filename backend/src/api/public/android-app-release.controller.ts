import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { AndroidAppReleaseLatestQuerySchema } from '@maimai-score-hub/shared';
import type { Response } from 'express';

import { AndroidAppReleaseService } from '../../modules/android-app-release/services/android-app-release.service';

@Controller('android/app/releases')
export class AndroidAppReleaseController {
  constructor(private readonly releases: AndroidAppReleaseService) {}

  @Get('latest')
  @Header('Cache-Control', 'no-store')
  async getLatest(@Query() rawQuery: Record<string, unknown>) {
    try {
      const query = AndroidAppReleaseLatestQuerySchema.parse(rawQuery);
      return this.releases.getLatest(query);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Get(':releaseId/manifest')
  @Header('Cache-Control', 'no-store')
  getManifest(@Param('releaseId') releaseId: string) {
    return this.releases.getManifest(releaseId);
  }

  @Get(':releaseId/apk')
  async getApk(
    @Param('releaseId') releaseId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const apk = await this.releases.getApk(releaseId);
    response.setHeader(
      'Content-Type',
      'application/vnd.android.package-archive',
    );
    response.setHeader('Content-Length', String(apk.size));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="MaiScoreHub-${releaseId}.apk"`,
    );
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('ETag', `"sha256-${apk.sha256}"`);
    return new StreamableFile(this.releases.createApkReadStream(apk.path));
  }
}
