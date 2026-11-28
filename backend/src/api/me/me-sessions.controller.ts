import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { AuthSessionService } from '../../modules/auth/services/auth-session.service';

type AuthedRequest = Request & { user?: { sub?: string; sid?: string } };

function userIdFrom(req: AuthedRequest): string {
  const userId = req.user?.sub;
  if (!userId) {
    throw new BadRequestException('No user context');
  }
  return userId;
}

@Controller('me/sessions')
@UseGuards(AuthGuard)
export class MeSessionsController {
  constructor(private readonly sessions: AuthSessionService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.sessions.listSessions(userIdFrom(req), req.user?.sid);
  }

  @Post('revoke-others')
  @HttpCode(200)
  async revokeOthers(@Req() req: AuthedRequest) {
    return this.sessions.revokeOtherSessions(userIdFrom(req), req.user?.sid);
  }

  @Delete(':id')
  @HttpCode(200)
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sessions.revokeSession(userIdFrom(req), id);
  }
}
