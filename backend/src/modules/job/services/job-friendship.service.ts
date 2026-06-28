import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { BotFriendSnapshotService } from '../../bots/services/bot-friend-snapshot.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { UsersService } from '../../users/services/users.service';
import type { JobType } from '../job.types';
import { JobEntity } from '../schemas/job.schema';
import { FRIENDSHIP_PROOF_MAX_AGE_MS } from './job.constants';

@Injectable()
export class JobFriendshipService {
  private readonly logger = new Logger(JobFriendshipService.name);

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly botFriendSnapshot: BotFriendSnapshotService,
    @Inject(forwardRef(() => BotStatusService))
    private readonly botStatus: BotStatusService,
  ) {}

  async tryCabinetFastPath(input: {
    friendCode: string;
    botUserFriendCode: string | null;
  }): Promise<{ friendshipReady: boolean; botUserFriendCode: string | null }> {
    let botFriendCode = input.botUserFriendCode;

    try {
      const user = await this.usersService.findByFriendCode(input.friendCode);
      const userCabinetUid = (user as { cabinetUserId?: number | null } | null)
        ?.cabinetUserId;
      if (userCabinetUid === null || userCabinetUid === undefined) {
        return { friendshipReady: false, botUserFriendCode: botFriendCode };
      }

      let botCabinetUid: number | null = null;
      if (botFriendCode) {
        const allBots = await this.botStatus.getAll();
        const bot = allBots.find((b) => b.friendCode === botFriendCode);
        botCabinetUid = bot?.cabinetUserId ?? null;
      } else {
        const picked = await this.botStatus.pickAvailableCabinetBot();
        if (picked) {
          botFriendCode = picked.friendCode;
          botCabinetUid = picked.cabinetUserId ?? null;
        }
      }

      if (
        botCabinetUid === null ||
        botCabinetUid === undefined ||
        !botFriendCode
      ) {
        return { friendshipReady: false, botUserFriendCode: botFriendCode };
      }

      try {
        const r = await this.sdgb.addRival(
          {
            botCabinetUserId: botCabinetUid,
            targetCabinetUserId: userCabinetUid,
          },
          {
            tag: `score-update-add:${input.friendCode}`,
            timeoutMs: 60_000,
          },
        );
        this.logger.log(
          `Cabinet fast-path fc=${input.friendCode} bot=${botFriendCode} addRival rc=${r.returnCode1}/${r.returnCode2}`,
        );
        return { friendshipReady: true, botUserFriendCode: botFriendCode };
      } catch (err) {
        this.logger.warn(
          `Cabinet fast-path addRival failed for fc=${input.friendCode}; needs explicit friendship job: ${err instanceof Error ? err.message : err}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `cabinet-bound fast-path lookup failed for ${input.friendCode}: ${err instanceof Error ? err.message : err}`,
      );
    }

    return { friendshipReady: false, botUserFriendCode: botFriendCode };
  }

  async resolveUpdateScoreFriendship(input: {
    friendCode: string;
    botUserFriendCode: string | null;
    friendshipReady: boolean;
  }): Promise<{ ready: boolean; botUserFriendCode: string | null }> {
    if (input.friendshipReady && input.botUserFriendCode) {
      return {
        ready: true,
        botUserFriendCode: input.botUserFriendCode,
      };
    }

    const availableBots = (await this.botStatus.getAll())
      .filter((bot) => bot.available)
      .sort((a, b) => (a.friendCount ?? 0) - (b.friendCount ?? 0));
    const availableBotCodes = availableBots.map((bot) => bot.friendCode);

    if (input.botUserFriendCode) {
      if (!availableBotCodes.includes(input.botUserFriendCode)) {
        const leastLoadedBot = availableBots[0]?.friendCode ?? null;
        return { ready: false, botUserFriendCode: leastLoadedBot };
      }

      const isFriend = await this.botFriendSnapshot.hasFriend(
        input.botUserFriendCode,
        input.friendCode,
      );
      return {
        ready: isFriend,
        botUserFriendCode: input.botUserFriendCode,
      };
    }

    const botHavingFriend = await this.botFriendSnapshot.findBotHavingFriend(
      input.friendCode,
      availableBotCodes,
    );
    if (botHavingFriend) {
      return { ready: true, botUserFriendCode: botHavingFriend };
    }

    const leastLoadedBot = availableBots[0]?.friendCode ?? null;

    return { ready: false, botUserFriendCode: leastLoadedBot };
  }

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
      .filter((bot) => bot.available)
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
      (user as { cabinetUserId?: number | null } | null)?.cabinetUserId != null;
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

  async resolveBotForCreate(input: {
    friendCode: string;
    jobType: JobType;
    botUserFriendCode: string | null;
  }): Promise<string> {
    if (input.botUserFriendCode) {
      return input.botUserFriendCode;
    }

    if (
      input.jobType === 'send_friend_request' ||
      input.jobType === 'accept_friend_request'
    ) {
      const picked = await this.botStatus.pickAvailableBot();
      if (!picked) {
        throw new BadRequestException('当前没有可用的 Bot');
      }
      return picked.friendCode;
    }

    if (input.jobType === 'get_full_friend_list') {
      return input.friendCode;
    }

    throw new BadRequestException(
      `jobType ${input.jobType} requires botUserFriendCode`,
    );
  }
}
