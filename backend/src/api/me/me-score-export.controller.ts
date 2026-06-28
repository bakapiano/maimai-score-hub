import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { ScoreExportService } from '../../modules/score-export/services/score-export.service';
import type { PlatePlan } from '../../modules/score-export/score-export.types';

type AuthedRequest = Request & {
  user?: { friendCode?: string; sub?: string };
};

function requireFriendCode(req: AuthedRequest): string {
  const friendCode = req.user?.friendCode;
  if (!friendCode) {
    throw new BadRequestException('Missing friendCode in token');
  }
  return friendCode;
}

@Controller('me/score-exports')
@UseGuards(AuthGuard)
export class MeScoreExportController {
  constructor(private readonly exporter: ScoreExportService) {}

  @Get('best50')
  async best50(@Req() req: AuthedRequest, @Res() res: Response) {
    const friendCode = requireFriendCode(req);
    const buffer = await this.exporter.generateBest50Image(friendCode);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="best50.png"');
    res.end(buffer);
  }

  @Get('level')
  async level(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query('level') level?: string,
  ) {
    const friendCode = requireFriendCode(req);
    const buffer = await this.exporter.generateLevelScoresImage(
      friendCode,
      level,
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="level-${sanitizeFilename(level)}.png"`,
    );
    res.end(buffer);
  }

  @Get('version')
  async version(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query('version') version?: string,
    @Query('minLevel') minLevel?: string,
    @Query('plan') plan?: string,
  ) {
    const friendCode = requireFriendCode(req);
    const minLevelNum = minLevel ? parseFloat(minLevel) : undefined;
    const validPlans = ['jiang', 'ji', 'wuwu', 'shen'];
    const platePlan: PlatePlan = validPlans.includes(plan ?? '')
      ? (plan as PlatePlan)
      : 'jiang';
    const buffer = await this.exporter.generateVersionScoresImage(
      friendCode,
      version,
      minLevelNum,
      platePlan,
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="version-${sanitizeFilename(version)}.png"`,
    );
    res.end(buffer);
  }
}

function sanitizeFilename(value?: string) {
  if (!value) {
    return 'unknown';
  }
  // Only allow ASCII-safe characters for Content-Disposition header
  return value.replace(/[^a-zA-Z0-9\-_]+/g, '_');
}
