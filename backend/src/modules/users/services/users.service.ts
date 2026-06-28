import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { promisify } from 'node:util';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { UserEntity } from '../schemas/user.schema';
import type { UserNetProfile } from '../user.types';

const scryptAsync = promisify(scrypt);
const PASSWORD_HASH_VERSION = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const FRIEND_CODE_RE = /^\d{15}$/;
type FriendListProfileRow = {
  friendCode: string;
  userName?: string | null;
  rating?: number | null;
  avatarUrl?: string | null;
  title?: string | null;
  titleColor?: string | null;
  ratingBgUrl?: string | null;
  courseRankUrl?: string | null;
  classRankUrl?: string | null;
  awakeningCount?: number | null;
};
type ProfileSetDoc = Record<string, string | number | null>;
const FRIEND_LIST_PROFILE_FIELDS: Array<
  readonly [keyof FriendListProfileRow, keyof UserNetProfile]
> = [
  ['avatarUrl', 'avatarUrl'],
  ['title', 'title'],
  ['titleColor', 'titleColor'],
  ['userName', 'username'],
  ['rating', 'rating'],
  ['ratingBgUrl', 'ratingBgUrl'],
  ['courseRankUrl', 'courseRankUrl'],
  ['classRankUrl', 'classRankUrl'],
  ['awakeningCount', 'awakeningCount'],
];

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

  async findByUsername(username: string) {
    const normalized = this.normalizeUsername(username);
    const doc = await this.userModel.findOne({ username: normalized });
    return doc ? doc.toObject() : null;
  }

  async verifyPasswordCredentials(
    login: { friendCode?: string; username?: string },
    password: string,
  ) {
    let query: { friendCode: string } | { username: string } | null = null;
    if (login.friendCode) {
      const friendCode = login.friendCode.trim();
      query = FRIEND_CODE_RE.test(friendCode) ? { friendCode } : null;
    } else if (login.username) {
      try {
        query = { username: this.normalizeUsername(login.username) };
      } catch {
        query = null;
      }
    }
    if (!query) {
      return null;
    }

    const doc = await this.userModel.findOne(query).select('+passwordHash');
    if (!doc?.passwordHash) {
      return null;
    }

    const ok = await this.verifyPassword(password, doc.passwordHash);
    if (!ok) {
      return null;
    }

    const user = doc.toObject() as unknown as Record<string, unknown>;
    delete user.passwordHash;
    return user;
  }

  /**
   * Look up a user by their bound cabinet (sdgb) userId. Used by the
   * QR-login flow's fast path: if the user has bound their cabinet id
   * before, we skip the addRival → snapshot reverse-map dance and
   * sign a token immediately.
   */
  async findByCabinetUserId(cabinetUserId: number) {
    const doc = await this.userModel.findOne({ cabinetUserId });
    return doc ? doc.toObject() : null;
  }

  /**
   * Hard-delete a user document. Caller (UsersController) is responsible
   * for fanning out to the join-on-friendCode collections owned by other
   * services (syncs, jobs) so we don't have to import those models here.
   */
  async deleteAccount(id: string): Promise<{
    deleted: boolean;
    friendCode: string;
  }> {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const friendCode = user.friendCode;
    await this.userModel.deleteOne({ _id: id });
    return { deleted: true, friendCode };
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

  async getByIdWithPasswordHash(id: string) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const doc = await this.userModel.findById(id).select('+passwordHash');
    if (!doc) {
      throw new NotFoundException('User not found');
    }
    return doc.toObject();
  }

  async create(input: {
    friendCode: string;
    username?: string | null;
    divingFishImportToken?: string | null;
    lxnsImportToken?: string | null;
    profile?: UserNetProfile | null;
    /** QR-login flow seeds this so subsequent logins hit the fast path. */
    cabinetUserId?: number | null;
  }) {
    const created = await this.userModel.create({
      friendCode: input.friendCode,
      username: input.username ? this.normalizeUsername(input.username) : null,
      divingFishImportToken: input.divingFishImportToken ?? null,
      lxnsImportToken: input.lxnsImportToken ?? null,
      profile: input.profile ?? null,
      cabinetUserId: input.cabinetUserId ?? null,
    });
    return created.toObject();
  }

  async update(
    id: string,
    input: {
      username?: string | null;
      divingFishImportToken?: string | null;
      lxnsImportToken?: string | null;
      profile?: UserNetProfile | null;
      cabinetUserId?: number | null;
      autoUpdate?: boolean;
    },
  ) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const updateDoc: Record<string, unknown> = {};
    if ('username' in input) {
      updateDoc.username = input.username
        ? this.normalizeUsername(input.username)
        : null;
    }
    if ('divingFishImportToken' in input) {
      updateDoc.divingFishImportToken = input.divingFishImportToken ?? null;
    }
    if ('lxnsImportToken' in input) {
      updateDoc.lxnsImportToken = input.lxnsImportToken ?? null;
    }
    if ('profile' in input) {
      updateDoc.profile = input.profile ?? null;
    }
    if ('cabinetUserId' in input) {
      updateDoc.cabinetUserId = input.cabinetUserId ?? null;
    }
    if ('autoUpdate' in input) {
      updateDoc.autoUpdate = !!input.autoUpdate;
    }
    const updated = await this.userModel.findByIdAndUpdate(id, updateDoc, {
      new: true,
    });

    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return updated.toObject();
  }

  async clearProberImportToken(
    friendCode: string,
    provider: 'divingFish' | 'lxns',
  ): Promise<void> {
    const field =
      provider === 'divingFish' ? 'divingFishImportToken' : 'lxnsImportToken';
    await this.userModel.updateOne({ friendCode }, { $set: { [field]: null } });
  }

  async setAccountPassword(
    id: string,
    input: {
      username?: string;
      currentPassword?: string;
      newPassword?: string;
    },
  ) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }
    if (input.username === undefined && input.newPassword === undefined) {
      throw new BadRequestException('username or newPassword is required');
    }

    const user = await this.userModel.findById(id).select('+passwordHash');
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updateDoc: Record<string, unknown> = {};
    const normalizedUsername =
      input.username !== undefined
        ? this.normalizeUsername(input.username)
        : undefined;
    const usernameChanged =
      normalizedUsername !== undefined &&
      normalizedUsername !== (user.username ?? null);
    const passwordChanged = input.newPassword !== undefined;
    const hasPassword = !!user.passwordHash;

    if (!hasPassword && !passwordChanged) {
      throw new BadRequestException('请先设置密码');
    }

    await this.verifyCurrentPasswordIfNeeded({
      hasPassword,
      changed: usernameChanged || passwordChanged,
      currentPassword: input.currentPassword,
      storedHash: user.passwordHash,
    });

    if (usernameChanged && normalizedUsername) {
      await this.ensureUsernameAvailable(normalizedUsername, user._id);
      updateDoc.username = normalizedUsername;
    }

    if (passwordChanged) {
      updateDoc.passwordHash = await this.hashPassword(input.newPassword!);
      updateDoc.passwordUpdatedAt = new Date();
    }

    if (Object.keys(updateDoc).length === 0) {
      return user.toObject();
    }

    const updated = await this.userModel
      .findByIdAndUpdate(id, updateDoc, {
        new: true,
      })
      .select('+passwordHash');
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated.toObject();
  }

  private async verifyCurrentPasswordIfNeeded(input: {
    hasPassword: boolean;
    changed: boolean;
    currentPassword?: string;
    storedHash?: string | null;
  }): Promise<void> {
    if (!input.hasPassword || !input.changed) {
      return;
    }
    if (!input.currentPassword) {
      throw new BadRequestException('请输入当前密码');
    }
    const currentPasswordOk = await this.verifyPassword(
      input.currentPassword,
      input.storedHash!,
    );
    if (!currentPasswordOk) {
      throw new BadRequestException('当前密码不正确');
    }
  }

  private async ensureUsernameAvailable(
    normalizedUsername: string,
    currentUserId: unknown,
  ): Promise<void> {
    const existing = await this.userModel.exists({
      _id: { $ne: currentUserId },
      username: normalizedUsername,
    });
    if (existing) {
      throw new ConflictException('用户名已被使用');
    }
  }

  private normalizeUsername(username: string): string {
    const normalized = username.trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      throw new BadRequestException(
        '用户名只能包含 3-32 位英文字母、数字或下划线',
      );
    }
    if (FRIEND_CODE_RE.test(normalized)) {
      throw new BadRequestException('用户名不能是 15 位纯数字好友码');
    }
    return normalized;
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scryptAsync(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
    )) as Buffer;
    return `${PASSWORD_HASH_VERSION}:${salt}:${derived.toString('hex')}`;
  }

  private async verifyPassword(
    password: string,
    storedHash: string,
  ): Promise<boolean> {
    const [version, salt, expectedHex] = storedHash.split(':');
    if (
      version !== PASSWORD_HASH_VERSION ||
      !salt ||
      !expectedHex ||
      expectedHex.length !== PASSWORD_KEY_LENGTH * 2
    ) {
      return false;
    }

    const expected = Buffer.from(expectedHex, 'hex');
    if (expected.length !== PASSWORD_KEY_LENGTH) {
      return false;
    }
    const actual = (await scryptAsync(
      password,
      salt,
      expected.length,
    )) as Buffer;
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  /**
   * Bulk-patch user.profile from worker-scraped friend list rows.
   *
   * Workers report bot friend snapshots on every status tick; each
   * row already carries the rich profile fields (avatar, title,
   * rating, awakening, etc) which we'd otherwise have to fetch via
   * a separate getUserProfile RPC. This is especially useful for
   * users who registered via QR login and never went through the
   * friend-search profile fetch — they'd otherwise show no profile
   * info on the website until their first manual sync.
   *
   * Behavior:
   *   - Only updates users that actually exist in our DB (other
   *     bot friends are ignored).
   *   - Only writes profile fields that are non-null in the input
   *     (preserves existing data when scrape returns null for a
   *     particular field).
   *   - Skips rows where userName is null AND rating is null AND
   *     all profile fields are null (nothing to write).
   *   - Uses bulkWrite to keep this O(1) round-trips even with 100+
   *     friends per bot.
   */
  async patchProfilesFromFriendList(
    rows: ReadonlyArray<FriendListProfileRow>,
  ): Promise<{ matched: number; modified: number }> {
    if (!rows.length) {
      return { matched: 0, modified: 0 };
    }

    // Use $set on individual nested keys (e.g. profile.avatarUrl) so we
    // don't clobber existing fields that aren't in the friend list scrape.
    const ops: Array<{
      updateOne: {
        filter: { friendCode: string };
        update: { $set: ProfileSetDoc };
      };
    }> = [];
    for (const r of rows) {
      const set = this.buildFriendListProfileSet(r);
      if (Object.keys(set).length === 0) {
        continue;
      }
      ops.push({
        updateOne: {
          filter: { friendCode: r.friendCode },
          update: { $set: set },
          // upsert: false — only patch users that already exist
        },
      });
    }
    if (!ops.length) {
      return { matched: 0, modified: 0 };
    }
    const result = await this.userModel.bulkWrite(ops, { ordered: false });
    return {
      matched: result.matchedCount ?? 0,
      modified: result.modifiedCount ?? 0,
    };
  }

  private buildFriendListProfileSet(row: FriendListProfileRow): ProfileSetDoc {
    const set: ProfileSetDoc = {};
    for (const [sourceKey, profileKey] of FRIEND_LIST_PROFILE_FIELDS) {
      const value = row[sourceKey];
      if (value !== null && value !== undefined) {
        set[`profile.${profileKey}`] = value;
      }
    }
    return set;
  }

  /**
   * 更新用户最后活跃时间
   */
  async updateLastActiveAt(userId: string): Promise<void> {
    if (!isValidObjectId(userId)) {
      return;
    }
    await this.userModel.updateOne(
      { _id: userId },
      { lastActiveAt: new Date() },
    );
  }

  /**
   * 批量查询用户活跃度
   */
  async getActivityByFriendCodes(friendCodes: string[]): Promise<
    {
      friendCode: string;
      lastActiveAt: Date | null;
      cabinetUserId: number | null;
    }[]
  > {
    if (!friendCodes.length) {
      return [];
    }
    const users = await this.userModel
      .find({ friendCode: { $in: friendCodes } })
      .select('friendCode lastActiveAt cabinetUserId')
      .lean();
    return users.map((u) => ({
      friendCode: u.friendCode,
      lastActiveAt: u.lastActiveAt ?? null,
      cabinetUserId: u.cabinetUserId ?? null,
    }));
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

  async countAutoUpdateUsers(): Promise<number> {
    return this.userModel.countDocuments({
      autoUpdate: true,
      cabinetUserId: { $ne: null },
    });
  }
}
