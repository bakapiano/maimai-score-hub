import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Post,
  Patch,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  StatsCardMutationSchema,
  StatsCardQuerySchema,
  StatsCardDisplayPatchSchema,
} from '@maimai-score-hub/shared';
import type {
  StatsCardTheme,
  StatsCardDisplayPatch,
} from '@maimai-score-hub/shared';
import type { Request, Response } from 'express';
import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { StatsCardService } from '../../modules/stats-card/stats-card.service';
import {
  StatsCardExceptionFilter,
  StatsCardRateLimit,
  sendStatsCard,
} from '../../modules/stats-card/stats-card.http';

type Authed = Request & { user?: { sub?: string } };
@Controller('me/stats-card')
@UseGuards(AuthGuard)
@UseFilters(StatsCardExceptionFilter)
export class MeStatsCardController {
  constructor(
    private readonly cards: StatsCardService,
    private readonly rates: StatsCardRateLimit,
  ) {}

  private user(req: Authed) {
    const id = req.user?.sub;
    if (!id) {
      throw new BadRequestException('No user context');
    }
    this.rates.take('me:' + id + ':' + Math.floor(Date.now() / 60_000), 60);
    return id;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  state(@Req() req: Authed) {
    return this.cards.state(this.user(req));
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  enable(
    @Req() req: Authed,
    @Body(new ZodValidationPipe(StatsCardMutationSchema))
    _body: Record<string, never>,
  ) {
    void _body;
    return this.cards.enable(this.user(req));
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  updateDisplay(
    @Req() req: Authed,
    @Body(new ZodValidationPipe(StatsCardDisplayPatchSchema))
    body: StatsCardDisplayPatch,
  ) {
    return this.cards.updateDisplay(this.user(req), body);
  }

  @Post('rotate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  rotate(
    @Req() req: Authed,
    @Body(new ZodValidationPipe(StatsCardMutationSchema))
    _body: Record<string, never>,
  ) {
    void _body;
    return this.cards.rotate(this.user(req));
  }

  @Delete()
  @Header('Cache-Control', 'no-store')
  disable(@Req() req: Authed) {
    return this.cards.disable(this.user(req));
  }

  @Get('preview.svg')
  async preview(
    @Req() req: Authed,
    @Res() res: Response,
    @Query(new ZodValidationPipe(StatsCardQuerySchema))
    query: { theme: StatsCardTheme },
  ) {
    await sendStatsCard(
      req,
      res,
      await this.cards.preview(this.user(req), query.theme),
      false,
    );
  }
}
