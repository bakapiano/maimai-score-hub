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
    if (!query) return null;

    const doc = await this.userModel.findOne(query).select('+passwordHash');
    if (!doc?.passwordHash) return null;

    const ok = await this.verifyPassword(password, doc.passwordHash);
    if (!ok) return null;

    const { passwordHash: _passwordHash, ...user } = doc.toObject() as Record<
      string,
      unknown
    >;
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
    if (!isValidObjectId(id)) throw new NotFoundException('User not found');
    const user = await this.userModel.findById(id);
    if (!user) throw new NotFoundException('User not found');
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
      autoExportDivingFish?: boolean;
      autoExportLxns?: boolean;
      cabinetUserId?: number | null;
      autoUpdate?: boolean;
      lastScoreHash?: string | null;
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
    if ('autoExportDivingFish' in input) {
      updateDoc.autoExportDivingFish = !!input.autoExportDivingFish;
    }
    if ('autoExportLxns' in input) {
      updateDoc.autoExportLxns = !!input.autoExportLxns;
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

    if (hasPassword && (usernameChanged || passwordChanged)) {
      if (!input.currentPassword) {
        throw new BadRequestException('请输入当前密码');
      }
      const currentPasswordOk = await this.verifyPassword(
        input.currentPassword,
        user.passwordHash!,
      );
      if (!currentPasswordOk) {
        throw new BadRequestException('当前密码不正确');
      }
    }

    if (usernameChanged && normalizedUsername) {
      const existing = await this.userModel.exists({
        _id: { $ne: user._id },
        username: normalizedUsername,
      });
      if (existing) {
        throw new ConflictException('用户名已被使用');
      }
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
    rows: ReadonlyArray<{
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
    }>,
  ): Promise<{ matched: number; modified: number }> {
    if (!rows.length) return { matched: 0, modified: 0 };

    // Use $set on individual nested keys (e.g. profile.avatarUrl) so we
    // don't clobber existing fields that aren't in the friend list scrape.
    type SetDoc = Record<string, string | number | null>;
    const ops: Array<{
      updateOne: {
        filter: { friendCode: string };
        update: { $set: SetDoc };
      };
    }> = [];
    for (const r of rows) {
      const set: SetDoc = {};
      if (r.avatarUrl != null) set['profile.avatarUrl'] = r.avatarUrl;
      if (r.title != null) set['profile.title'] = r.title;
      if (r.titleColor != null) set['profile.titleColor'] = r.titleColor;
      if (r.userName != null) set['profile.username'] = r.userName;
      if (r.rating != null) set['profile.rating'] = r.rating;
      if (r.ratingBgUrl != null) set['profile.ratingBgUrl'] = r.ratingBgUrl;
      if (r.courseRankUrl != null)
        set['profile.courseRankUrl'] = r.courseRankUrl;
      if (r.classRankUrl != null) set['profile.classRankUrl'] = r.classRankUrl;
      if (r.awakeningCount != null)
        set['profile.awakeningCount'] = r.awakeningCount;
      if (Object.keys(set).length === 0) continue;
      ops.push({
        updateOne: {
          filter: { friendCode: r.friendCode },
          update: { $set: set },
          // upsert: false — only patch users that already exist
        },
      });
    }
    if (!ops.length) return { matched: 0, modified: 0 };
    const result = await this.userModel.bulkWrite(ops, { ordered: false });
    return {
      matched: result.matchedCount ?? 0,
      modified: result.modifiedCount ?? 0,
    };
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
   * 批量返回这些 friendCode 中、确实存在对应 user 文档的子集。
   * cleanup 用它区分「null 活跃度但是注册用户」（可驱逐）和
   * 「后端查无此人」（保守保留）。
   */
  async getExistingFriendCodes(friendCodes: string[]): Promise<string[]> {
    if (!friendCodes.length) return [];
    const users = await this.userModel
      .find({ friendCode: { $in: friendCodes } })
      .select('friendCode')
      .lean();
    return users.map((u) => u.friendCode);
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
        $or: [{ lastHashCheckAt: null }, { lastHashCheckAt: { $lte: cutoff } }],
      },
      { $set: { lastHashCheckAt: now } },
    );
    return res.modifiedCount === 1;
  }

  /**
   * Throttle CAS for the auto-update sweep's job-creation phase.
   * Identical contract to tryClaimHashCheck but scoped to job creation.
   * Combined with an in-flight update_score check, prevents both
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

  /**
   * Record a failed auto-update job and schedule the next attempt via
   * exponential backoff. Returns the new (failureCount, backoffUntil)
   * so callers can log them.
   *
   * Atomicity: uses findOneAndUpdate with $inc so the read-modify-write
   * of failureCount can't race against a concurrent successful job
   * completion that calls resetAutoUpdateBackoff. We then compute
   * backoffUntil from the post-increment
   * count returned by findOneAndUpdate and write it in a second op.
   *
   * Why two ops? Mongo aggregation-pipeline updates could do this in
   * one round-trip, but they make the math (Math.pow + Math.min) noisy
   * and harder to read. The window between the two ops is at most a
   * few ms; the worst-case interleaving is:
   *   - Op1 (this fn): $inc count 2→3 returns 3
   *   - resetAutoUpdateBackoff: count 3→0, backoff→null
   *   - Op2 (this fn): set backoffUntil = now+2h    ← stale
   * The cron sweep then reads count=0, backoffUntil=future and skips
   * the user once — next tick (5min later) it'll see backoffUntil
   * still future and skip again, until the window expires. Total
   * impact: at most one extra skipped sweep after a success reset, no
   * correctness loss.
   */
  async recordAutoUpdateFailure(
    id: string,
    opts: { baseMs: number; factor: number; capMs: number },
    now: Date = new Date(),
  ): Promise<{ failureCount: number; backoffUntil: Date } | null> {
    if (!isValidObjectId(id)) return null;
    const updated = await this.userModel.findOneAndUpdate(
      { _id: id },
      { $inc: { autoUpdateFailureCount: 1 } },
      { new: true, projection: { autoUpdateFailureCount: 1 } },
    );
    if (!updated) return null;
    const nextCount = updated.autoUpdateFailureCount ?? 1;
    const delay = Math.min(
      opts.capMs,
      Math.floor(opts.baseMs * Math.pow(opts.factor, nextCount - 1)),
    );
    const backoffUntil = new Date(now.getTime() + delay);
    // Conditional write: only set backoffUntil if the failure count
    // we see is still ours. If a reset already zeroed it out (count
    // dropped below nextCount), we MUST NOT clobber the reset's
    // backoffUntil=null. The filter on autoUpdateFailureCount >= our
    // value is the guard.
    await this.userModel.updateOne(
      { _id: id, autoUpdateFailureCount: { $gte: nextCount } },
      { $set: { autoUpdateBackoffUntil: backoffUntil } },
    );
    return { failureCount: nextCount, backoffUntil };
  }

  /**
   * Clear backoff state. Called by JobService.patch on successful
   * update_score completion alongside the lastScoreHash promote.
   */
  async resetAutoUpdateBackoff(id: string): Promise<void> {
    if (!isValidObjectId(id)) return;
    await this.userModel.updateOne(
      { _id: id },
      {
        $set: {
          autoUpdateFailureCount: 0,
          autoUpdateBackoffUntil: null,
        },
      },
    );
  }
}
