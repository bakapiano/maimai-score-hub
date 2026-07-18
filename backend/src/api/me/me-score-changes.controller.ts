import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ScoreChangeHistoryQuerySchema,
  type ScoreChangeHistoryQuery,
} from '@maimai-score-hub/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { ScoreChangeHistoryService } from '../../modules/sync/services/score-change-history.service';

type AuthedRequest = Request & { user?: { friendCode?: string } };

@Controller('me/score-changes')
@UseGuards(AuthGuard)
export class MeScoreChangesController {
  constructor(private readonly history: ScoreChangeHistoryService) {}

  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(ScoreChangeHistoryQuerySchema))
    query: ScoreChangeHistoryQuery,
  ) {
    const friendCode = req.user?.friendCode;
    if (!friendCode) {
      throw new BadRequestException('Missing friendCode in token');
    }
    return this.history.listForUser(friendCode, query);
  }
}
