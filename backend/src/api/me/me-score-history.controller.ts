import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ScoreHistoryFeedQuerySchema,
  type ScoreHistoryFeedQuery,
  ScoreHistoryCalendarQuerySchema,
  type ScoreHistoryCalendarQuery,
} from '@maimai-score-hub/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { ScoreChangeHistoryService } from '../../modules/sync/services/score-change-history.service';

type AuthedRequest = Request & { user?: { friendCode?: string } };

@Controller('me/score-history')
@UseGuards(AuthGuard)
export class MeScoreHistoryController {
  constructor(private readonly history: ScoreChangeHistoryService) {}

  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(ScoreHistoryFeedQuerySchema))
    query: ScoreHistoryFeedQuery,
  ) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }
    return this.history.listFeedForUser(friendCode, query);
  }

  @Get('calendar')
  async calendar(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(ScoreHistoryCalendarQuerySchema))
    query: ScoreHistoryCalendarQuery,
  ) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }
    return this.history.getCalendarForUser(friendCode, query);
  }
}
