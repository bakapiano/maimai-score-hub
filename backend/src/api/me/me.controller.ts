import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BindCabinetQrBodySchema,
  DivingFishTokenBodySchema,
  SetAccountPasswordBodySchema,
  UpdateProfileBodySchema,
  type BindCabinetQrBody,
  type DivingFishTokenBody,
  type SetAccountPasswordBody,
  type UpdateProfileBody,
} from '@maimai-score-hub/shared';
import type { Request } from 'express';

import { AccountDeletionService } from '../../modules/users/services/account-deletion.service';
import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { CabinetService } from '../../modules/users/services/cabinet.service';
import { UsersService } from '../../modules/users/services/users.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { getImportToken } from '../../common/prober/diving-fish/api';

type AuthedRequest = Request & { userId?: string };

function extractUserId(req: AuthedRequest): string | undefined {
  const typed = req as unknown as {
    user?: { sub?: unknown };
    userId?: unknown;
  };
  const candidate = typed.user?.sub ?? typed.userId;
  return typeof candidate === 'string' ? candidate : undefined;
}

function toSafeProfile(user: Record<string, unknown>) {
  const {
    divingFishImportToken,
    lxnsImportToken,
    cabinetUserId,
    passwordHash,
    ...rest
  } = user;
  return {
    ...rest,
    id: String(user._id ?? user.id),
    hasDivingFishImportToken: !!divingFishImportToken,
    hasLxnsImportToken: !!lxnsImportToken,
    hasCabinetUserId: cabinetUserId !== null && cabinetUserId !== undefined,
    hasPassword: !!passwordHash,
    autoUpdate: !!user.autoUpdate,
  };
}

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly cabinet: CabinetService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  @Get()
  async profile(@Req() req: AuthedRequest) {
    // AuthGuard populates req.user; also allow legacy req.userId
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    const user = await this.users.getByIdWithPasswordHash(userId);
    // Never expose actual tokens, passwordHash, or raw cabinetUserId.
    return toSafeProfile(user as unknown as Record<string, unknown>);
  }

  @Patch()
  async updateProfile(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(UpdateProfileBodySchema))
    body: UpdateProfileBody,
  ) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    const updateInput: Record<string, unknown> = {};

    if (body.divingFishImportToken !== undefined) {
      updateInput.divingFishImportToken = body.divingFishImportToken ?? null;
    }
    if (body.lxnsImportToken !== undefined) {
      updateInput.lxnsImportToken = body.lxnsImportToken ?? null;
    }
    if (body.autoUpdate !== undefined) {
      if (body.autoUpdate) {
        const user = await this.users.getById(userId);
        if (user.cabinetUserId === null || user.cabinetUserId === undefined) {
          throw new BadRequestException('请先绑定二维码再开启自动更新');
        }
      }
      updateInput.autoUpdate = body.autoUpdate;
    }

    await this.users.update(userId, updateInput);
    const updated = await this.users.getByIdWithPasswordHash(userId);
    return toSafeProfile(updated as unknown as Record<string, unknown>);
  }

  @Put('password')
  @HttpCode(200)
  async setPassword(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(SetAccountPasswordBodySchema))
    body: SetAccountPasswordBody,
  ) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    const updated = await this.users.setAccountPassword(userId, body);
    return toSafeProfile(updated as unknown as Record<string, unknown>);
  }

  /**
   * 通过水鱼账户的用户名和密码获取 import token
   * 注意：用户名和密码仅用于一次性获取 token，不会被保存
   * 如果用户已有 import token 则直接返回，不会生成新的
   */
  @Post('prober-tokens/diving-fish')
  async getDivingFishToken(
    @Body(new ZodValidationPipe(DivingFishTokenBodySchema))
    body: DivingFishTokenBody,
  ) {
    try {
      return await getImportToken(body.username, body.password);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '获取 token 失败';
      throw new BadRequestException(message);
    }
  }

  /**
   * Bind a maimai cabinet (sdgb) userId to the current account by scanning
   * the player's physical-card QR. Accepts EITHER:
   *   - JSON  body { qrCode: "SGWCMAID..." }
   *   - multipart/form-data field `image` (PNG/JPG)
   */
  @Put('cabinet')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('image'))
  async bindCabinet(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() rawBody: unknown,
  ) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    // multer eats the JSON body when content-type is multipart, so do
    // schema validation only when we got JSON.
    let qrFromBody: string | undefined;
    if (!file) {
      const parsed: BindCabinetQrBody = BindCabinetQrBodySchema.parse(
        rawBody ?? {},
      );
      qrFromBody = parsed.qrCode ?? undefined;
    } else {
      // multer body fields are strings; allow `qrCode` as a fallback even
      // when image is present (caller might want to pass a pre-decoded one).
      const maybe = (rawBody as { qrCode?: unknown } | undefined)?.qrCode;
      if (typeof maybe === 'string' && maybe.length > 0) {
        qrFromBody = maybe;
      }
    }

    let qrCode = qrFromBody;
    if (!qrCode && file) {
      qrCode = (await this.cabinet.decodeQrImage(file.buffer)) ?? undefined;
      if (!qrCode) {
        throw new BadRequestException('图片中未识别出二维码');
      }
    }
    if (!qrCode) {
      throw new BadRequestException(
        '请提供 qrCode 字段或上传 image 字段的二维码图片',
      );
    }

    const user = await this.users.getById(userId);
    if (
      (user as { cabinetUserId?: number | null }).cabinetUserId !== null &&
      (user as { cabinetUserId?: number | null }).cabinetUserId !== undefined
    ) {
      throw new BadRequestException('该账号已绑定二维码，无法重复绑定');
    }
    const result = await this.cabinet.bindByQr(user.friendCode, qrCode);

    if (!result.ok) {
      if (result.reason === 'no-sync') {
        throw new BadRequestException('请先完成一次成绩同步后再绑定二维码');
      }
      throw new ConflictException({
        error: 'user id not match',
        matchedRows: result.matchedRows,
      });
    }

    await this.users.update(userId, { cabinetUserId: result.cabinetUserId });
    return { ok: true as const };
  }

  /**
   * Unbind the cabinet (sdgb) userId from the current account. Also
   * turns auto-update off (it can't fire without cabinetUserId).
   */
  @Delete('cabinet')
  @HttpCode(200)
  async unbindCabinet(@Req() req: AuthedRequest) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    const user = await this.users.getById(userId);
    if (user.cabinetUserId === null || user.cabinetUserId === undefined) {
      throw new BadRequestException('当前账号未绑定二维码');
    }
    await this.users.update(userId, {
      cabinetUserId: null,
      autoUpdate: false,
    });
    return { ok: true as const };
  }

  @Delete()
  @HttpCode(200)
  async deleteMyAccount(@Req() req: AuthedRequest) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    return this.accountDeletion.deleteAccount(userId);
  }
}
