import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { BotStatusService } from '../../bots/services/bot-status.service';
import { ConfigService } from '@nestjs/config';
import { JobService } from '../../job/services/job.service';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../../users/services/users.service';

export type AuthTokenPayload = {
  sub?: string;
  friendCode?: string;
  iat?: number;
  exp?: number;
};

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
      return { skipAuth: true, ...(await this.signForUser(user as never)) };
    }

    if (method === 'user_sends_request') {
      const selectedBot = await this.botStatus.pickAvailableBot();
      if (!selectedBot) {
        throw new BadRequestException('当前没有可用的 Bot');
      }

      const result = await this.jobs.create({
        friendCode: normalized,
        jobType: 'accept_friend_request',
        botUserFriendCode: selectedBot.friendCode,
      });

      return {
        ...result,
        userId: user._id,
        botFriendCode: selectedBot.friendCode,
        createdAt: result.job.createdAt,
      };
    }

    const result = await this.jobs.create({
      friendCode: normalized,
      jobType: 'send_friend_request',
    });

    return { ...result, userId: user._id };
  }

  async checkStatus(jobId: string) {
    const job = await this.jobs.get(jobId);
    const status = job.status;
    if (
      job.jobType !== 'accept_friend_request' &&
      job.jobType !== 'send_friend_request'
    ) {
      throw new BadRequestException('Not a login request job');
    }

    const verified =
      status === 'completed' ||
      (job.jobType === 'accept_friend_request' &&
        job.stage === 'accept_request');

    if (verified) {
      const user = await this.users.findByFriendCode(job.friendCode);
      if (!user) {
        throw new NotFoundException('User not found for job');
      }

      const userId = String(user._id);
      if (job.profile) {
        await this.users.update(userId, { profile: job.profile });
      }

      const signed = await this.signForUser(user as never);
      return {
        status,
        token: signed.token,
        user: signed.user,
      };
    }

    return { status, job };
  }

  async loginWithPassword(
    login: { friendCode?: string; username?: string },
    password: string,
  ) {
    const user = await this.users.verifyPasswordCredentials(login, password);
    if (!user) {
      throw new UnauthorizedException('账号或密码不正确');
    }
    this.updateLastActiveAt(String(user._id));
    return this.signForUser(user as never);
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
    return { job: await this.jobs.wake(jobId) };
  }

  verifyToken(token: string): AuthTokenPayload | null {
    try {
      return this.jwt.verify<AuthTokenPayload>(token);
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

  private async signForUser(user: {
    _id: unknown;
    friendCode: string;
    [key: string]: unknown;
  }): Promise<{
    token: string;
    user: { id: string; friendCode: string; [key: string]: unknown };
  }> {
    const safeUser = { ...user };
    delete safeUser.passwordHash;
    delete safeUser.divingFishImportToken;
    delete safeUser.lxnsImportToken;
    delete safeUser.cabinetUserId;
    const now = Math.floor(Date.now() / 1000);
    const userId = String(user._id);
    const token = await this.jwt.signAsync(
      {
        sub: userId,
        friendCode: user.friendCode,
        iat: now,
      },
      { expiresIn: '30d' },
    );
    return {
      token,
      user: { ...safeUser, id: userId, friendCode: user.friendCode },
    };
  }
}
