import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { getImportToken } from '../../common/prober/diving-fish/api';
import { JobService } from '../job/job.service';
import { BotStatusService } from '../admin/bot-status.service';

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
  ) {}

  @Get('profile')
  async profile(@Req() req: AuthedRequest) {
    // AuthGuard populates req.user; also allow legacy req.userId
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }
    return this.users.getById(userId);
  }

  @Patch('profile')
  async updateProfile(
    @Req() req: AuthedRequest,
    @Body()
    body: { divingFishImportToken?: unknown; lxnsImportToken?: unknown },
  ) {
    const userId = extractUserId(req);
    if (!userId) {
      throw new BadRequestException('No user context');
    }

    const divingFishToken = (() => {
      if (
        body.divingFishImportToken === undefined ||
        body.divingFishImportToken === null
      ) {
        return null;
      }
      if (typeof body.divingFishImportToken !== 'string') {
        throw new BadRequestException('divingFishImportToken must be a string');
      }
      return body.divingFishImportToken;
    })();

    const lxnsToken = (() => {
      if (body.lxnsImportToken === undefined || body.lxnsImportToken === null) {
        return null;
      }
      if (typeof body.lxnsImportToken !== 'string') {
        throw new BadRequestException('lxnsImportToken must be a string');
      }
      return body.lxnsImportToken;
    })();

    return this.users.update(userId, {
      divingFishImportToken: divingFishToken,
      lxnsImportToken: lxnsToken,
    });
  }

  /**
   * 通过水鱼账户的用户名和密码获取 import token
   * 注意：用户名和密码仅用于一次性获取 token，不会被保存
   * 如果用户已有 import token 则直接返回，不会生成新的
   */
  @Post('diving-fish/token')
  async getDivingFishToken(
    @Body() body: { username?: unknown; password?: unknown },
  ) {
    if (typeof body.username !== 'string' || !body.username) {
      throw new BadRequestException('username is required');
    }
    if (typeof body.password !== 'string' || !body.password) {
      throw new BadRequestException('password is required');
    }

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
    const availableBots = this.botStatus.getAll().filter((b) => b.available);
    if (!availableBots.length) {
      throw new BadRequestException('当前没有可用的 Bot');
    }

    const limit = Number(process.env.BOT_IDLE_FRIEND_LIMIT ?? 80);

    // 找一个有容量的 bot
    let selectedBot: string | null = null;
    for (const bot of availableBots) {
      const count = await this.users.countIdleUpdateByBot(bot.friendCode);
      const reportedCount = this.botStatus.getFriendCount(bot.friendCode) ?? 0;
      if (count < limit && reportedCount < limit) {
        selectedBot = bot.friendCode;
        break;
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
}
