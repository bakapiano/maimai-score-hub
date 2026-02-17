import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import {
  LoginRequestBodySchema,
  LoginStatusQuerySchema,
  type LoginRequestBody,
  type LoginStatusQuery,
} from '@maimai-score-hub/shared';

import { AuthService } from './auth.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login-request')
  async loginRequest(
    @Body(new ZodValidationPipe(LoginRequestBodySchema)) body: LoginRequestBody,
  ) {
    return this.auth.requestLogin(
      body.friendCode,
      body.skipUpdateScore,
      body.useIdleUpdate,
    );
  }

  @Get('login-status')
  async loginStatus(
    @Query(new ZodValidationPipe(LoginStatusQuerySchema)) query: LoginStatusQuery,
  ) {
    return this.auth.checkStatus(query.jobId);
  }
}
