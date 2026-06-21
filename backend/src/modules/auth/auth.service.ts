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
    method: 'bot_sends_request' | 'user_sends_request',
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

    if (method === 'user_sends_request') {
      const availableBots = (await this.botStatus.getAll()).filter(
        (b) => b.available,
      );
      if (!availableBots.length) {
        throw new BadRequestException('当前没有可用的 Bot');
      }

      const selectedBot =
        availableBots
          .slice()
          .sort((a, b) => (a.friendCount ?? 0) - (b.friendCount ?? 0))[0]
          ?.friendCode ?? null;

      const result = await this.jobs.create({
        friendCode: normalized,
        skipUpdateScore,
        jobType: 'accept_friend_request',
        botUserFriendCode: selectedBot,
      });

      return {
        ...result,
        userId: user._id,
        botFriendCode: selectedBot,
        createdAt: result.job.createdAt,
      };
    }

    const result = await this.jobs.create({
      friendCode: normalized,
      skipUpdateScore,
      jobType: 'send_friend_request',
    });

    return { ...result, userId: user._id };
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
      let syncJob: unknown;
      let syncJobId: string | undefined;
      if (!job.skipUpdateScore && job.jobType !== 'update_score') {
        const active = await this.jobs.getActiveByFriendCode(job.friendCode);
        if (active) {
          syncJob = active;
          syncJobId = active.id;
        } else {
          const created = await this.jobs.create({
            friendCode: job.friendCode,
            skipUpdateScore: false,
            jobType: 'update_score',
            botUserFriendCode: job.botUserFriendCode ?? undefined,
            isAuthenticated: true,
            friendshipReady: true,
          });
          syncJob = created.job;
          syncJobId = created.jobId;
        }
      }
      return { status, token, user, syncJobId, syncJob };
    }

    return { status, job };
  }

  async verifyLoginRequest(jobId: string) {
    const job = await this.jobs.get(jobId);
    if (
      job.jobType !== 'accept_friend_request' &&
      job.jobType !== 'send_friend_request'
    ) {
      throw new BadRequestException(
        'verify is only valid for login friend-request jobs',
      );
    }
    if (job.executing) {
      return { job };
    }
    return { job: await this.jobs.wake(jobId) };
  }

  verifyToken(token: string) {
    try {
      return this.jwt.verify(token);
    } catch {
      return null;
    }
  }

  /**
   * 更新用户最后活跃时间（fire-and-forget）
   */
  updateLastActiveAt(userId: string): void {
    this.users.updateLastActiveAt(userId).catch(() => {});
  }
}
