import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import {
  StatsCardCodeSchema,
  StatsCardQuerySchema,
} from '@maimai-score-hub/shared';
import type { StatsCardTheme } from '@maimai-score-hub/shared';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { StatsCardService } from '../../modules/stats-card/stats-card.service';
import {
  StatsCardExceptionFilter,
  StatsCardRateLimit,
  sendStatsCard,
} from '../../modules/stats-card/stats-card.http';

@Controller('stats')
@UseFilters(StatsCardExceptionFilter)
export class PublicStatsCardController {
  constructor(
    private readonly cards: StatsCardService,
    private readonly rates: StatsCardRateLimit,
  ) {}

  @Get(':code/card.svg')
  async image(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query(new ZodValidationPipe(StatsCardQuerySchema))
    query: { theme: StatsCardTheme },
  ) {
    this.rates.take(
      'public:' + req.ip + ':' + Math.floor(Date.now() / 60_000),
      600,
    );
    if (!StatsCardCodeSchema.safeParse(code).success) {
      throw new NotFoundException();
    }
    await sendStatsCard(
      req,
      res,
      await this.cards.publicImage(code, query.theme),
      true,
    );
  }
}
