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

  async requestLogin(friendCode: string, skipUpdateScore = true) {
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

    // 如果用户开启了闲时更新，优先选择不是闲时更新的那个 bot
    let botUserFriendCode: string | undefined;
    if (user.idleUpdateBotFriendCode) {
      const availableBots = this.botStatus.getAll().filter((b) => b.available);
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
