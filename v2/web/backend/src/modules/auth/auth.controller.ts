import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';

import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login-request')
  async loginRequest(
    @Body() body: { friendCode?: unknown; skipUpdateScore?: unknown },
  ) {
    if (typeof body.friendCode !== 'string') {
      throw new BadRequestException('friendCode is required');
    }
    const anyBody = body as Record<string, unknown>;
    const skipUpdateScore =
      anyBody.skipUpdateScore === undefined
        ? true
        : Boolean(anyBody.skipUpdateScore);

    return this.auth.requestLogin(body.friendCode, skipUpdateScore);
  }

  @Get('login-status')
  async loginStatus(@Query('jobId') jobId?: string) {
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }
    return this.auth.checkStatus(jobId);
  }
}
