import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { UserEntity } from './user.schema';
import type { UserNetProfile } from './user.types';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(UserEntity.name)
    private readonly userModel: Model<UserEntity>,
  ) {}

  async findByFriendCode(friendCode: string) {
    const doc = await this.userModel.findOne({ friendCode });
    return doc ? doc.toObject() : null;
  }

  async getById(id: string) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const doc = await this.userModel.findById(id);
    if (!doc) {
      throw new NotFoundException('User not found');
    }
    return doc.toObject();
  }

  async create(input: {
    friendCode: string;
    divingFishImportToken?: string | null;
    lxnsImportToken?: string | null;
    profile?: UserNetProfile | null;
  }) {
    const created = await this.userModel.create({
      friendCode: input.friendCode,
      divingFishImportToken: input.divingFishImportToken ?? null,
      lxnsImportToken: input.lxnsImportToken ?? null,
      profile: input.profile ?? null,
    });
    return created.toObject();
  }

  async update(
    id: string,
    input: {
      divingFishImportToken?: string | null;
      lxnsImportToken?: string | null;
      profile?: UserNetProfile | null;
      idleUpdateBotFriendCode?: string | null;
      autoExportDivingFish?: boolean;
      autoExportLxns?: boolean;
      preferredBotFriendCode?: string | null;
      cabinetUserId?: number | null;
      autoUpdate?: boolean;
      lastScoreHash?: string | null;
    },
  ) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const updateDoc: Record<string, unknown> = {};
    if ('divingFishImportToken' in input) {
      updateDoc.divingFishImportToken = input.divingFishImportToken ?? null;
    }
    if ('lxnsImportToken' in input) {
      updateDoc.lxnsImportToken = input.lxnsImportToken ?? null;
    }
    if ('profile' in input) {
      updateDoc.profile = input.profile ?? null;
    }
    if ('idleUpdateBotFriendCode' in input) {
      updateDoc.idleUpdateBotFriendCode = input.idleUpdateBotFriendCode ?? null;
    }
    if ('autoExportDivingFish' in input) {
      updateDoc.autoExportDivingFish = !!input.autoExportDivingFish;
    }
    if ('autoExportLxns' in input) {
      updateDoc.autoExportLxns = !!input.autoExportLxns;
    }
    if ('preferredBotFriendCode' in input) {
      updateDoc.preferredBotFriendCode = input.preferredBotFriendCode ?? null;
    }
    if ('cabinetUserId' in input) {
      updateDoc.cabinetUserId = input.cabinetUserId ?? null;
    }
    if ('autoUpdate' in input) {
      updateDoc.autoUpdate = !!input.autoUpdate;
    }
    if ('lastScoreHash' in input) {
      updateDoc.lastScoreHash = input.lastScoreHash ?? null;
    }

    const updated = await this.userModel.findByIdAndUpdate(id, updateDoc, {
      new: true,
    });

    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return updated.toObject();
  }

  /**
   * 获取所有开启了闲时更新的用户
   */
  async getIdleUpdateUsers() {
    const users = await this.userModel
      .find({ idleUpdateBotFriendCode: { $ne: null } })
      .lean();
    return users;
  }

  /**
   * 更新用户最后活跃时间
   */
  async updateLastActiveAt(userId: string): Promise<void> {
    if (!isValidObjectId(userId)) return;
    await this.userModel.updateOne(
      { _id: userId },
      { lastActiveAt: new Date() },
    );
  }

  /**
   * 更新用户偏好的 bot
   */
  async updatePreferredBot(
    friendCode: string,
    botFriendCode: string,
  ): Promise<void> {
    await this.userModel.updateOne(
      { friendCode },
      { preferredBotFriendCode: botFriendCode },
    );
  }

  /**
   * 获取用户偏好的 bot
   */
  async getPreferredBot(friendCode: string): Promise<string | null> {
    const user = await this.userModel
      .findOne({ friendCode })
      .select('preferredBotFriendCode')
      .lean();
    return user?.preferredBotFriendCode ?? null;
  }

  /**
   * 批量查询用户活跃度
   */
  async getActivityByFriendCodes(
    friendCodes: string[],
  ): Promise<{ friendCode: string; lastActiveAt: Date | null }[]> {
    if (!friendCodes.length) return [];
    const users = await this.userModel
      .find({ friendCode: { $in: friendCodes } })
      .select('friendCode lastActiveAt')
      .lean();
    return users.map((u) => ({
      friendCode: u.friendCode,
      lastActiveAt: u.lastActiveAt ?? null,
    }));
  }

  /**
   * 统计某个 bot 有多少用户正在使用它做闲时更新
   */
  async countIdleUpdateByBot(botFriendCode: string): Promise<number> {
    return this.userModel.countDocuments({
      idleUpdateBotFriendCode: botFriendCode,
    });
  }

  /**
   * 获取所有开启了"自动更新"且已绑定 cabinetUserId 的用户。
   * 由 auto-update scheduler 每隔 AUTO_UPDATE_CRON 扫描调用。
   */
  async getAutoUpdateUsers() {
    return this.userModel
      .find({ autoUpdate: true, cabinetUserId: { $ne: null } })
      .lean();
  }

  /**
   * 写入最新观察到的成绩 hash。无论触发出来的 job 是否成功都会更新，
   * 因为我们要保证下一次扫到相同 hash 时不再重复触发。
   */
  async setLastScoreHash(id: string, hash: string): Promise<void> {
    if (!isValidObjectId(id)) return;
    await this.userModel.updateOne(
      { _id: id },
      { $set: { lastScoreHash: hash } },
    );
  }

  /**
   * Conditional CAS variant of setLastScoreHash, used by the auto-update
   * sweep to settle a per-user race between multiple backend instances.
   *
   * Returns true only when the user document still had `expected` as its
   * lastScoreHash (so we successfully "won" the hash flip). When false,
   * another instance already observed and recorded this transition — the
   * caller should NOT trigger a duplicate update job.
   */
  async tryAdvanceLastScoreHash(
    id: string,
    expected: string | null,
    next: string,
  ): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const filter: Record<string, unknown> = { _id: id };
    // Mongo treats `field: null` as matching documents where the field is
    // null OR missing, which is what we want for first-time runs.
    filter.lastScoreHash = expected;
    const res = await this.userModel.updateOne(filter, {
      $set: { lastScoreHash: next },
    });
    return res.modifiedCount === 1;
  }

  /**
   * Throttle CAS for the auto-update sweep's hash-check phase. The user
   * document is updated only if `lastHashCheckAt` is null or older than
   * `now - throttleMs`. Returns true on success (the caller goes on to
   * actually call sdgb-worker).
   *
   * The "winner takes it" semantic is enforced by the atomic updateOne;
   * multiple backend instances racing on the same user will see exactly
   * one modifiedCount=1, the rest get 0.
   */
  async tryClaimHashCheck(
    id: string,
    throttleMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const cutoff = new Date(now.getTime() - throttleMs);
    const res = await this.userModel.updateOne(
      {
        _id: id,
        $or: [
          { lastHashCheckAt: null },
          { lastHashCheckAt: { $lte: cutoff } },
        ],
      },
      { $set: { lastHashCheckAt: now } },
    );
    return res.modifiedCount === 1;
  }

  /**
   * Throttle CAS for the auto-update sweep's job-creation phase.
   * Identical contract to tryClaimHashCheck but scoped to job creation.
   * Combined with an in-flight idle_update_score check, prevents both
   * back-to-back duplicate jobs and the "create cancels in-flight" foot-gun.
   */
  async tryClaimAutoUpdateJob(
    id: string,
    throttleMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const cutoff = new Date(now.getTime() - throttleMs);
    const res = await this.userModel.updateOne(
      {
        _id: id,
        $or: [
          { lastAutoUpdateJobAt: null },
          { lastAutoUpdateJobAt: { $lte: cutoff } },
        ],
      },
      { $set: { lastAutoUpdateJobAt: now } },
    );
    return res.modifiedCount === 1;
  }
}
