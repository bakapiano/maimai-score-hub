import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { BotStatusService } from '../admin/bot-status.service';
import { ConfigService } from '@nestjs/config';
import { JobService } from '../job/job.service';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  private readonly skipAuth: boolean;

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly jobs: JobService,
    private readonly botStatus: BotStatusService,
    config: ConfigService,
  ) {
    this.skipAuth = config.get<string>('SKIP_AUTH', 'false') === 'true';
  }

  async requestLogin(
    friendCode: string,
    skipUpdateScore = true,
    useIdleUpdate = false,
  ) {
    const normalized = friendCode.trim();
    if (!normalized) {
      throw new BadRequestException('friendCode is required');
    }

    let user = await this.users.findByFriendCode(normalized);
    if (!user) {
      user = await this.users.create({ friendCode: normalized });
    }

    console.log(this.skipAuth);

    // Skip auth: directly return token without creating job, for testing purposes
    if (this.skipAuth) {
      const now = Math.floor(Date.now() / 1000);
      const userId = String(user._id);
      const payload = {
        sub: userId,
        friendCode: user.friendCode,
        iat: now,
      };
      const token = await this.jwt.signAsync(payload, {
        expiresIn: '30d',
      });
      return { skipAuth: true, token, user };
    }

    // 如果用户选择了闲时更新，创建 idle_add_friend job
    if (useIdleUpdate && !skipUpdateScore) {
      // 检查是否已有活跃的闲时任务
      const hasActive = await this.jobs.hasActiveIdleJob(normalized);
      if (hasActive) {
        throw new BadRequestException(
          '已有进行中的闲时更新任务，请勿重复创建',
        );
      }

      // 选择好友最少的可用 bot
      const availableBots = (await this.botStatus.getAll()).filter(
        (b) => b.available,
      );
      if (!availableBots.length) {
        throw new BadRequestException('当前没有可用的 Bot');
      }

      const limit = Number(process.env.BOT_IDLE_FRIEND_LIMIT ?? 80);
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

      const { jobId } = await this.jobs.create({
        friendCode: normalized,
        skipUpdateScore: true,
        jobType: 'idle_add_friend',
        botUserFriendCode: selectedBot,
      });

      return { jobId, userId: user._id };
    }

    // 如果用户开启了闲时更新，优先选择不是闲时更新的那个 bot
    let botUserFriendCode: string | undefined;
    if (user.idleUpdateBotFriendCode) {
      const availableBots = (await this.botStatus.getAll()).filter(
        (b) => b.available,
      );
      const nonIdleBot = availableBots.find(
        (b) => b.friendCode !== user.idleUpdateBotFriendCode,
      );
      botUserFriendCode =
        nonIdleBot?.friendCode ?? availableBots[0]?.friendCode;
    }

    const { jobId } = await this.jobs.create({
      friendCode: normalized,
      skipUpdateScore,
      botUserFriendCode,
    });

    return { jobId, userId: user._id };
  }

  async checkStatus(jobId: string) {
    const job = await this.jobs.get(jobId);
    const status = job.status;
    const stage = job.stage;

    if (
      status === 'completed' ||
      (status === 'processing' && stage === 'update_score')
    ) {
      const user = await this.users.findByFriendCode(job.friendCode);
      if (!user) {
        throw new NotFoundException('User not found for job');
      }

      const now = Math.floor(Date.now() / 1000);
      const userId = String(user._id);
      if (job.profile) {
        await this.users.update(userId, { profile: job.profile });
      }

      const payload = {
        sub: userId,
        friendCode: user.friendCode,
        iat: now,
      };
      const token = await this.jwt.signAsync(payload, {
        expiresIn: '30d',
      });
      return { status, token, user };
    }

    return { status, job };
  }

  verifyToken(token: string) {
    try {
      return this.jwt.verify(token);
    } catch {
      return null;
    }
  }
}
