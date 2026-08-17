import {
  BadRequestException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { BotFriendSnapshotService } from '../../bots/services/bot-friend-snapshot.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { UsersService } from '../../users/services/users.service';
import { JobEntity } from '../schemas/job.schema';
import { FRIENDSHIP_PROOF_MAX_AGE_MS } from './job.constants';

@Injectable()
export class JobFriendshipService {
  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly botFriendSnapshot: BotFriendSnapshotService,
    @Inject(forwardRef(() => BotStatusService))
    private readonly botStatus: BotStatusService,
  ) {}

  async resolveCompletedFriendshipProof(input: {
    friendCode: string;
    friendshipJobId?: string;
    now: Date;
  }): Promise<string | null> {
    if (!input.friendshipJobId) {
      return null;
    }

    const proof = await this.jobModel
      .findOne({
        id: input.friendshipJobId,
        friendCode: input.friendCode,
        jobType: 'send_friend_request',
        status: 'completed',
        botUserFriendCode: { $ne: null },
      })
      .lean<JobEntity | null>()
      .exec();

    if (!proof?.botUserFriendCode) {
      throw new BadRequestException({
        code: 'invalid_friendship_proof',
        message: '好友关系验证任务不存在或尚未完成',
      });
    }

    if (
      input.now.getTime() - new Date(proof.updatedAt).getTime() >
      FRIENDSHIP_PROOF_MAX_AGE_MS
    ) {
      throw new BadRequestException({
        code: 'invalid_friendship_proof',
        message: '好友关系验证任务已过期，请重新检查好友状态',
      });
    }

    return proof.botUserFriendCode;
  }

  async resolveFreshSnapshotBot(input: {
    friendCode: string;
    botFriendCodes: string[];
    now: Date;
  }): Promise<string | null> {
    return this.botFriendSnapshot.findFreshBotHavingFriend(
      input.friendCode,
      input.botFriendCodes,
      new Date(input.now.getTime() - 5 * 60_000),
    );
  }

  async getTargetCabinetUserId(friendCode: string): Promise<number | null> {
    const user = await this.usersService.findByFriendCode(friendCode);
    const value = (user as { cabinetUserId?: number | null } | null)
      ?.cabinetUserId;
    return value === null || value === undefined ? null : value;
  }

  async getFriendshipStatus(friendCode: string): Promise<{
    isFriend: boolean;
    hasCabinetUserId: boolean;
    botFriendCode: string | null;
    recommendedBotFriendCode: string | null;
    availableBotCount: number;
    friendsUpdatedAt: string | null;
    checkedAt: string;
  }> {
    const availableBots = (await this.botStatus.getAll())
      .filter((bot) => bot.available && !!bot.workerId)
      .sort((a, b) => (a.friendCount ?? 0) - (b.friendCount ?? 0));
    const availableBotCodes = availableBots.map((bot) => bot.friendCode);
    const botFriendCode = await this.botFriendSnapshot.findBotHavingFriend(
      friendCode,
      availableBotCodes,
    );
    const snap = botFriendCode
      ? await this.botFriendSnapshot.get(botFriendCode)
      : null;
    const user = await this.usersService.findByFriendCode(friendCode);
    const hasCabinetUserId =
      (user as { cabinetUserId?: number | null } | null)?.cabinetUserId !==
        null &&
      (user as { cabinetUserId?: number | null } | null)?.cabinetUserId !==
        undefined;
    const recommendedBotFriendCode =
      botFriendCode ?? availableBots[0]?.friendCode ?? null;

    return {
      isFriend: !!botFriendCode,
      hasCabinetUserId,
      botFriendCode,
      recommendedBotFriendCode,
      availableBotCount: availableBots.length,
      friendsUpdatedAt: snap?.updatedAt?.toISOString() ?? null,
      checkedAt: new Date().toISOString(),
    };
  }
}
