import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  LoginByQrBodySchema,
  LoginRequestBodySchema,
  LoginStatusQuerySchema,
  type LoginByQrBody,
  type LoginRequestBody,
  type LoginStatusQuery,
} from '@maimai-score-hub/shared';

import { AuthService } from './auth.service';
import { QrLoginService } from './qr-login.service';
import { decodeQrImage } from '../../common/qr-decode';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly qrLogin: QrLoginService,
  ) {}

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

  /**
   * QR-code login. Accepts EITHER:
   *   - JSON body  { qrCode: "SGWCMAID..." }
   *   - multipart  field `image` (PNG/JPG of the player's card QR)
   *
   * Returns { token, user } on success. 4xx with { error } when the cabinet
   * lookup, b50 calc, or reverse-mapping fails (e.g. ambiguous name+rating).
   */
  @Post('login-by-qr')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('image'))
  async loginByQr(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() rawBody: unknown,
  ) {
    let qrFromBody: string | undefined;
    if (!file) {
      const parsed: LoginByQrBody = LoginByQrBodySchema.parse(rawBody ?? {});
      qrFromBody = parsed.qrCode ?? undefined;
    } else {
      const maybe = (rawBody as { qrCode?: unknown } | undefined)?.qrCode;
      if (typeof maybe === 'string' && maybe.length > 0) {
        qrFromBody = maybe;
      }
    }

    let qrCode = qrFromBody;
    if (!qrCode && file) {
      qrCode = (await decodeQrImage(file.buffer)) ?? undefined;
      if (!qrCode) {
        throw new BadRequestException('图片中未识别出二维码');
      }
    }
    if (!qrCode) {
      throw new BadRequestException(
        '请提供 qrCode 字段或上传 image 字段的二维码图片',
      );
    }

    try {
      return await this.qrLogin.loginByQr(qrCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(message);
    }
  }
}
