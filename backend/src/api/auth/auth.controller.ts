import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  NotFoundException,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  LoginByQrBodySchema,
  LoginRequestBodySchema,
  LogoutBodySchema,
  PasswordLoginBodySchema,
  RefreshTokenBodySchema,
  type LoginByQrBody,
  type LoginRequestBody,
  type LogoutBody,
  type PasswordLoginBody,
  type RefreshTokenBody,
} from '@maimai-score-hub/shared';

import { AuthService } from '../../modules/auth/services/auth.service';
import { AuthSessionService } from '../../modules/auth/services/auth-session.service';
import {
  QrExpiredError,
  QrLoginService,
} from '../../modules/auth/services/qr-login.service';
import { decodeQrImage } from '../../common/qr-decode';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: AuthSessionService,
    private readonly qrLogin: QrLoginService,
  ) {}

  @Post('login-requests')
  async loginRequest(
    @Req() req: Request,
    @Body(new ZodValidationPipe(LoginRequestBodySchema)) body: LoginRequestBody,
  ) {
    return this.auth.requestLogin(body.friendCode, body.method, {
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('login-requests/:jobId/verify')
  @HttpCode(200)
  async verifyLoginRequest(@Param('jobId') jobId: string) {
    return this.auth.verifyLoginRequest(jobId);
  }

  @Get('login-requests/:jobId')
  async loginStatus(@Req() req: Request, @Param('jobId') jobId: string) {
    return this.auth.checkStatus(jobId, {
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('password-login')
  @HttpCode(200)
  async passwordLogin(
    @Req() req: Request,
    @Body(new ZodValidationPipe(PasswordLoginBodySchema))
    body: PasswordLoginBody,
  ) {
    return this.auth.loginWithPassword(
      { friendCode: body.friendCode, username: body.username },
      body.password,
      { userAgent: req.headers['user-agent'] ?? null },
    );
  }

  /**
   * QR-code login. Accepts EITHER:
   *   - JSON body  { qrCode: "SGWCMAID..." }
   *   - multipart  field `image` (PNG/JPG of the player's card QR)
   *
   * Returns { token, user } on success. 4xx with { error } when the cabinet
   * lookup, b50 calc, or reverse-mapping fails (e.g. ambiguous name+rating).
   */
  @Post('qr-login')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('image'))
  async loginByQr(
    @Req() req: Request,
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
      return await this.qrLogin.loginByQr(qrCode, {
        userAgent: req.headers['user-agent'] ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface a stable error code for the FE to render targeted UI.
      if (err instanceof QrExpiredError) {
        throw new BadRequestException({
          code: 'qr_expired',
          message,
        });
      }
      throw new BadRequestException(message);
    }
  }

  /**
   * QR-login progress poll (slow path). FE hits this every 1-2s after
   * the original POST returned `{kind:'async', attemptId}`. Response
   * statuses: pending / fetching_before / adding_rival / fetching_after /
   * matched (token attached) / failed (error attached).
   */
  @Get('qr-login/:attemptId')
  async pollLoginByQr(@Param('attemptId') attemptId: string) {
    try {
      return await this.qrLogin.pollAttempt(attemptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'attempt not found') {
        throw new NotFoundException({ error: message });
      }
      throw new BadRequestException(message);
    }
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Body(new ZodValidationPipe(RefreshTokenBodySchema))
    body: RefreshTokenBody,
  ) {
    return this.sessions.refreshSession(body.refreshToken, {
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('upgrade')
  @HttpCode(200)
  async upgrade(@Req() req: Request) {
    const rawHeader =
      req.headers['authorization'] || req.headers['Authorization'];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (
      !header ||
      typeof header !== 'string' ||
      !header.toLowerCase().startsWith('bearer ')
    ) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const rawToken = header.slice(7).trim();
    const payload = this.auth.verifyToken(rawToken);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return this.sessions.upgradeLegacyToken(payload, rawToken, {
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Body(new ZodValidationPipe(LogoutBodySchema))
    body: LogoutBody,
  ) {
    let currentSid: string | undefined;
    const rawHeader =
      req.headers['authorization'] || req.headers['Authorization'];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (
      header &&
      typeof header === 'string' &&
      header.toLowerCase().startsWith('bearer ')
    ) {
      const payload = this.auth.verifyToken(header.slice(7).trim());
      currentSid = payload?.sid;
    }
    return this.sessions.logout(body?.refreshToken, currentSid);
  }
}
