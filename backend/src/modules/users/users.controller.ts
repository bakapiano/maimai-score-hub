import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BindCabinetQrBodySchema,
  DivingFishTokenBodySchema,
  SetAutoUpdateBodySchema,
  UpdateProfileBodySchema,
  type BindCabinetQrBody,
  type DivingFishTokenBody,
  type SetAutoUpdateBody,
  type UpdateProfileBody,
} from '@maimai-score-hub/shared';
import { UsersService } from './users.service';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { getImportToken } from '../../common/prober/diving-fish/api';
import { JobService } from '../job/job.service';
import { BotStatusService } from '../admin/bot-status.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CabinetService } from './cabinet.service';

type AuthedRequest = Request & { userId?: string };

function extractUserId(req: AuthedRequest): string | undefined {
  const typed = req as unknown as {
    user?: { sub?: unknown };
    userId?: unknown;
  };
  const candidate = typed.user?.sub ?? typed.userId;
  return typeof candidate === 'string' ? candidate : undefined;
}

@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly jobs: JobService,
    private readonly botStatus: BotStatusService,
    private readonly cabinet: CabinetService,
  ) {}

  @Get('profile')
  async profile(@Req() req: AuthedRequest) {
    // AuthGuard populates req.user; also allow legacy req.userId
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    const user = await this.users.getById(userId);
    // Never expose actual tokens to the client
    const { divingFishImportToken, lxnsImportToken, ...rest } = user;
    return {
      ...rest,
      hasDivingFishImportToken: !!divingFishImportToken,
      hasLxnsImportToken: !!lxnsImportToken,
      cabinetUserId: user.cabinetUserId ?? null,
      autoUpdate: !!user.autoUpdate,
      lastScoreHash: user.lastScoreHash ?? null,
    };
  }

  @Patch('profile')
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
    if (body.autoExportDivingFish !== undefined) {
      updateInput.autoExportDivingFish = body.autoExportDivingFish;
    }
    if (body.autoExportLxns !== undefined) {
      updateInput.autoExportLxns = body.autoExportLxns;
    }

    const updated = await this.users.update(userId, updateInput);

    // Never expose actual tokens to the client
    const {
      divingFishImportToken: _df,
      lxnsImportToken: _lx,
      ...rest
    } = updated;
    return {
      ...rest,
      hasDivingFishImportToken: !!_df,
      hasLxnsImportToken: !!_lx,
    };
  }

  /**
   * 通过水鱼账户的用户名和密码获取 import token
   * 注意：用户名和密码仅用于一次性获取 token，不会被保存
   * 如果用户已有 import token 则直接返回，不会生成新的
   */
  @Post('diving-fish/token')
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
   * 开启闲时更新：创建 idle_add_friend job
   */
  @Post('idle-update/enable')
  async enableIdleUpdate(@Req() req: AuthedRequest) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    const user = await this.users.getById(userId);

    // 已经开启了闲时更新
    if (user.idleUpdateBotFriendCode) {
      throw new BadRequestException('闲时更新已开启');
    }

    // 检查是否已有活跃的闲时任务
    const hasActive = await this.jobs.hasActiveIdleJob(user.friendCode);
    if (hasActive) {
      throw new BadRequestException('已有进行中的闲时更新任务，请勿重复创建');
    }

    // 检查 bot 好友容量
    const availableBots = (await this.botStatus.getAll()).filter(
      (b) => b.available,
    );
    if (!availableBots.length) {
      throw new BadRequestException('当前没有可用的 Bot');
    }

    const limit = Number(process.env.BOT_IDLE_FRIEND_LIMIT ?? 60);

    // 找好友最少的一个有容量的 bot，避免倾斜到同一个 bot
    let selectedBot: string | null = null;
    let minCount = Infinity;
    for (const bot of availableBots) {
      const count = await this.users.countIdleUpdateByBot(bot.friendCode);
      const reportedCount =
        (await this.botStatus.getFriendCount(bot.friendCode)) ?? 0;
      const effectiveCount = Math.max(count, reportedCount);
      if (effectiveCount < limit && effectiveCount < minCount) {
        selectedBot = bot.friendCode;
        minCount = effectiveCount;
      }
    }

    if (!selectedBot) {
      throw new BadRequestException('所有 Bot 的闲时更新名额已满');
    }

    // 创建 idle_add_friend job
    const result = await this.jobs.create({
      friendCode: user.friendCode,
      skipUpdateScore: true,
      jobType: 'idle_add_friend',
      botUserFriendCode: selectedBot,
      isAuthenticated: true,
    });

    return { ...result, message: '闲时更新任务已创建，等待 Bot 添加好友' };
  }

  /**
   * 取消闲时更新
   */
  @Post('idle-update/disable')
  async disableIdleUpdate(@Req() req: AuthedRequest) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    await this.users.update(userId, { idleUpdateBotFriendCode: null });
    return { ok: true, message: '闲时更新已关闭' };
  }

  /**
   * 获取闲时更新状态
   */
  @Get('idle-update/status')
  async getIdleUpdateStatus(@Req() req: AuthedRequest) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    const user = await this.users.getById(userId);
    const activeJob = await this.jobs.getActiveIdleJob(user.friendCode);

    return {
      enabled: !!user.idleUpdateBotFriendCode,
      botFriendCode: user.idleUpdateBotFriendCode ?? null,
      pendingJob: !!activeJob,
      activeJob,
    };
  }

  /**
   * Bind a maimai cabinet (sdgb) userId to the current account by scanning
   * the player's physical-card QR. Accepts EITHER:
   *   - JSON  body { qrCode: "SGWCMAID..." }
   *   - multipart/form-data field `image` (PNG/JPG)
   *
   * The endpoint is the only place we go from QR → cabinetUserId, so the
   * verification step (≥5 score rows must match) lives here too. See
   * CabinetService.bindByQr.
   */
  @Post('cabinet/bind-qr')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('image'))
  async bindCabinetQr(
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
    const result = await this.cabinet.bindByQr(user.friendCode, qrCode);

    if (!result.ok) {
      if (result.reason === 'no-sync') {
        throw new BadRequestException(
          '请先完成一次成绩同步后再绑定二维码',
        );
      }
      throw new ConflictException({
        error: 'user id not match',
        matchedRows: result.matchedRows,
      });
    }

    await this.users.update(userId, { cabinetUserId: result.cabinetUserId });
    return { ok: true as const, cabinetUserId: result.cabinetUserId };
  }

  /**
   * Toggle the auto-update opt-in. Requires cabinetUserId to already be
   * bound; the scheduler ignores users without it anyway, but the explicit
   * check here surfaces the requirement to the UI.
   */
  @Post('cabinet/auto-update')
  @HttpCode(201)
  async setAutoUpdate(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(SetAutoUpdateBodySchema))
    body: SetAutoUpdateBody,
  ) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    const user = await this.users.getById(userId);
    if (body.enabled && user.cabinetUserId == null) {
      throw new BadRequestException('请先绑定二维码再开启自动更新');
    }
    const updated = await this.users.update(userId, {
      autoUpdate: body.enabled,
    });
    return { ok: true as const, autoUpdate: !!updated.autoUpdate };
  }
}
