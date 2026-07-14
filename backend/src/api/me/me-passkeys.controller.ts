import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  DeletePasskeyBodySchema,
  PasskeyRegistrationOptionsBodySchema,
  PasskeyRegistrationVerifyBodySchema,
  RenamePasskeyBodySchema,
  type DeletePasskeyBody,
  type PasskeyRegistrationOptionsBody,
  type PasskeyRegistrationVerifyBody,
  type RenamePasskeyBody,
} from '@maimai-score-hub/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { PasskeyService } from '../../modules/auth/services/passkey.service';

type AuthedRequest = Request & { user?: { sub?: string } };

function userIdFrom(req: AuthedRequest): string {
  const userId = req.user?.sub;
  if (!userId) {
    throw new BadRequestException('No user context');
  }
  return userId;
}

@Controller('me/passkeys')
@UseGuards(AuthGuard)
export class MePasskeysController {
  constructor(private readonly passkeys: PasskeyService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.passkeys.list(userIdFrom(req));
  }

  @Post('registration/options')
  @HttpCode(200)
  async registrationOptions(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(PasskeyRegistrationOptionsBodySchema))
    body: PasskeyRegistrationOptionsBody,
  ) {
    return this.passkeys.createRegistrationOptions(
      userIdFrom(req),
      body.password,
    );
  }

  @Post('registration/verify')
  @HttpCode(201)
  async registrationVerify(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(PasskeyRegistrationVerifyBodySchema))
    body: PasskeyRegistrationVerifyBody,
  ) {
    return this.passkeys.verifyRegistration(
      userIdFrom(req),
      body.ceremonyId,
      body.name,
      body.response,
    );
  }

  @Patch(':id')
  async rename(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenamePasskeyBodySchema))
    body: RenamePasskeyBody,
  ) {
    return this.passkeys.rename(userIdFrom(req), id, body.name);
  }

  @Post(':id/delete')
  @HttpCode(200)
  async delete(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DeletePasskeyBodySchema))
    body: DeletePasskeyBody,
  ) {
    return this.passkeys.delete(userIdFrom(req), id, body.password);
  }
}
