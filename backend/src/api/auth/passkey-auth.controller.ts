import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  PasskeyAuthenticationVerifyBodySchema,
  type PasskeyAuthenticationVerifyBody,
} from '@maimai-score-hub/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PasskeyService } from '../../modules/auth/services/passkey.service';

@Controller('auth/passkey')
export class PasskeyAuthController {
  constructor(private readonly passkeys: PasskeyService) {}

  @Post('options')
  @HttpCode(200)
  async options(@Req() req: Request) {
    return this.passkeys.createAuthenticationOptions(
      req.ip ?? req.socket.remoteAddress ?? 'unknown',
    );
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Req() req: Request,
    @Body(new ZodValidationPipe(PasskeyAuthenticationVerifyBodySchema))
    body: PasskeyAuthenticationVerifyBody,
  ) {
    return this.passkeys.verifyAuthentication(
      req.ip ?? req.socket.remoteAddress ?? 'unknown',
      body.ceremonyId,
      body.response,
    );
  }
}
