import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import {
  DXNET_PRIORITY,
  type SdgbWorkerMusicEntry,
} from '@maimai-score-hub/shared';

import { getRating } from '../../../common/rating';
import { BotFriendSnapshotService } from '../../bots/services/bot-friend-snapshot.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { JobService } from '../../job/services/job.service';
import { MusicEntity } from '../../music/schemas/music.schema';
import type {
  ChartPayload,
  MusicDocument,
} from '../../music/schemas/music.schema';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { DxnetRoutingControlService } from '../../job/services/dxnet-routing-control.service';
import {
  QrLoginAttemptEntity,
  type QrLoginAttemptDocument,
  type QrLoginAttemptEntity as QrIdentityAttempt,
} from '../schemas/qr-login-attempt.schema';
import { randomUUID } from 'node:crypto';

export type CabinetIdentityScan = Awaited<
  ReturnType<SdgbJobDispatcher['scanQr']>
>;

export type CabinetIdentityMatchStage = 'adding_rival' | 'waiting_snapshot';

export interface PreparedCabinetIdentity {
  cabinetUserId: number;
  rivalName: string;
  rating: number;
  bot: {
    friendCode: string;
    cabinetUserId: number;
  };
}

export type PreparedCabinetIdentityCore = Omit<PreparedCabinetIdentity, 'bot'>;

interface ResolveOptions {
  tagPrefix: string;
  context: string;
  source?: 'qr_login' | 'cabinet_binding';
  onStage?: (stage: CabinetIdentityMatchStage) => void | Promise<void>;
}

/** Shared slow-path identity resolver used by QR login and QR binding. */
@Injectable()
export class CabinetIdentityMatcherService {
  private readonly logger = new Logger(CabinetIdentityMatcherService.name);

  constructor(
    private readonly sdgb: SdgbJobDispatcher,
    private readonly botStatus: BotStatusService,
    private readonly snapshot: BotFriendSnapshotService,
    private readonly jobs: JobService,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
    @InjectModel(QrLoginAttemptEntity.name)
    private readonly attemptModel: Model<QrLoginAttemptDocument>,
    private readonly routingControl: DxnetRoutingControlService,
  ) {}

  async isClaimIdentityEnabled(): Promise<boolean> {
    const control = await this.routingControl.get();
    return this.routingControl.isClaimFlowEnabled(control, 'qr_identity', null);
  }

  async prepareIdentity(
    scan: CabinetIdentityScan,
  ): Promise<PreparedCabinetIdentityCore> {
    if (!scan.rivalName) {
      throw new Error('cabinet did not return rival name; cannot match');
    }
    const rating = await this.computeB50(scan.music);
    if (rating === null) {
      throw new Error(
        '无法从机台成绩计算 rating（可能 music 表未同步），请稍后重试',
      );
    }
    return {
      cabinetUserId: scan.cabinetUserId,
      rivalName: scan.rivalName,
      rating,
    };
  }

  async startClaimResolution(
    scan: CabinetIdentityScan,
    input: {
      purpose: 'login' | 'cabinet_binding';
      ownerUserId?: string | null;
      expectedFriendCode?: string | null;
    },
  ): Promise<{ attemptId: string; identity: PreparedCabinetIdentityCore }> {
    const identity = await this.prepareIdentity(scan);
    const attemptId = randomUUID();
    const dxnetJobId = randomUUID();
    await this.attemptModel.create({
      id: attemptId,
      purpose: input.purpose,
      ownerUserId: input.ownerUserId ?? null,
      expectedFriendCode: input.expectedFriendCode ?? null,
      status: 'pending',
      cabinetUserId: identity.cabinetUserId,
      rivalName: identity.rivalName,
      computedRating: identity.rating,
      botUserFriendCode: null,
      dxnetJobId,
      resolvedFriendCode: null,
      token: null,
      error: null,
    });
    try {
      const job = await this.jobs.createIdentityResolution({
        jobId: dxnetJobId,
        attemptId,
        source: input.purpose === 'login' ? 'qr_login' : 'cabinet_binding',
      });
      if (job.jobId !== dxnetJobId) {
        throw new Error('DXNet identity job id mismatch');
      }
    } catch (error) {
      await this.attemptModel.updateOne(
        { id: attemptId },
        {
          $set: {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      );
      throw error;
    }
    return { attemptId, identity };
  }

  async resolveAttemptSnapshot(
    attempt: QrIdentityAttempt,
    freshAfter: Date,
  ): Promise<
    | { kind: 'waiting' }
    | { kind: 'found'; friendCode: string; botFriendCode: string }
    | { kind: 'failed'; error: string }
  > {
    if (
      !attempt.botUserFriendCode ||
      !attempt.rivalName ||
      attempt.computedRating === null
    ) {
      return { kind: 'waiting' };
    }
    const snapshot = await this.snapshot.get(attempt.botUserFriendCode);
    if (
      !snapshot?.updatedAt ||
      snapshot.updatedAt.getTime() < freshAfter.getTime()
    ) {
      return { kind: 'waiting' };
    }
    try {
      return {
        kind: 'found',
        friendCode: this.findUniqueFriendCode(
          snapshot.friends,
          attempt.rivalName,
          attempt.computedRating,
        ),
        botFriendCode: attempt.botUserFriendCode,
      };
    } catch (error) {
      return {
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async prepare(scan: CabinetIdentityScan): Promise<PreparedCabinetIdentity> {
    const identity = await this.prepareIdentity(scan);

    const control = await this.routingControl.get();
    const pickedBot = await this.botStatus.pickAvailableCabinetBot({
      allowlist: control.botAllowlist,
    });
    if (!pickedBot || pickedBot.cabinetUserId === null) {
      throw new Error(
        '当前没有可用的、配置了 cabinetUserId 的 bot，请稍后重试或使用 friendCode 登录',
      );
    }

    return {
      ...identity,
      bot: {
        friendCode: pickedBot.friendCode,
        cabinetUserId: pickedBot.cabinetUserId,
      },
    };
  }

  async match(
    scan: CabinetIdentityScan,
    options: ResolveOptions,
  ): Promise<PreparedCabinetIdentity & { friendCode: string }> {
    const prepared = await this.prepare(scan);
    const friendCode = await this.resolveFriendCode(prepared, options);
    return { ...prepared, friendCode };
  }

  async resolveFriendCode(
    identity: PreparedCabinetIdentity,
    options: ResolveOptions,
  ): Promise<string> {
    await options.onStage?.('adding_rival');
    const rival = await this.sdgb.addRival(
      {
        botCabinetUserId: identity.bot.cabinetUserId,
        targetCabinetUserId: identity.cabinetUserId,
      },
      {
        tag: `${options.tagPrefix}-add:${identity.cabinetUserId}`,
        timeoutMs: 60_000,
        priority: DXNET_PRIORITY.immediate,
      },
    );
    this.logger.log(
      `${options.context} addRival rc1=${rival.returnCode1} rc2=${rival.returnCode2}`,
    );
    const triggeredAt = new Date();

    await options.onStage?.('waiting_snapshot');
    const refreshJob = await this.jobs.create({
      friendCode: identity.bot.friendCode,
      jobType: 'get_full_friend_list',
      source: options.source ?? 'qr_login',
      botUserFriendCode: identity.bot.friendCode,
      cancelActiveJobs: false,
    });
    this.logger.log(
      `${options.context} dispatched full friend-list refresh job=${refreshJob.jobId} bot=${identity.bot.friendCode}`,
    );

    const snap = await this.pollFreshSnapshot(
      identity.bot.friendCode,
      triggeredAt,
    );
    if (!snap?.updatedAt) {
      throw new Error(
        '未在超时时间内拿到 bot 最新好友列表快照（worker 未上报），请稍后重试',
      );
    }
    this.logger.log(
      `${options.context} snapshot updatedAt=${snap.updatedAt.toISOString()} friends=${snap.friends.length}`,
    );
    return this.findUniqueFriendCode(
      snap.friends,
      identity.rivalName,
      identity.rating,
    );
  }

  private async pollFreshSnapshot(botFriendCode: string, triggeredAt: Date) {
    const snapshotWaitDeadlineMs = 90_000;
    const snapshotPollIntervalMs = 2_000;
    const deadline = Date.now() + snapshotWaitDeadlineMs;
    let snap = await this.snapshot.get(botFriendCode);
    while (
      Date.now() < deadline &&
      (!snap?.updatedAt || snap.updatedAt.getTime() <= triggeredAt.getTime())
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, snapshotPollIntervalMs),
      );
      snap = await this.snapshot.get(botFriendCode);
    }
    return snap?.updatedAt && snap.updatedAt.getTime() > triggeredAt.getTime()
      ? snap
      : null;
  }

  private findUniqueFriendCode(
    friends: Array<{
      friendCode: string;
      userName: string | null;
      rating: number | null;
    }>,
    rivalName: string,
    rating: number,
  ): string {
    const matches = friends.filter(
      (candidate) =>
        candidate.userName === rivalName && candidate.rating === rating,
    );
    if (matches.length === 0) {
      const sample = friends
        .slice(0, 5)
        .map(
          (candidate) =>
            `${candidate.friendCode}(${candidate.userName}|${candidate.rating})`,
        )
        .join(', ');
      throw new Error(
        `bot 好友列表里未找到 name=${rivalName} rating=${rating} 的记录 (sample: ${sample})`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `候选好友里找到 ${matches.length} 个 name=${rivalName} rating=${rating} 的记录，请使用 friendCode 登录`,
      );
    }
    return matches[0].friendCode;
  }

  /** Standard maimai B50: top 15 new + top 35 old. */
  private async computeB50(
    music: SdgbWorkerMusicEntry[],
  ): Promise<number | null> {
    const allMusic = (await this.musicModel.find().lean()) as Array<{
      id: string;
      isNew?: boolean | null;
      charts?: ChartPayload[];
    }>;
    const byNumericId = new Map<
      number,
      { isNew: boolean | null; charts: ChartPayload[] }
    >();
    for (const item of allMusic) {
      const numericId = Number(item.id);
      if (!Number.isFinite(numericId)) {
        continue;
      }
      byNumericId.set(numericId, {
        isNew: item.isNew ?? null,
        charts: item.charts ?? [],
      });
    }

    const rows: Array<{ isNew: boolean | null; rating: number }> = [];
    for (const entry of music) {
      const metadata = byNumericId.get(entry.musicId);
      if (!metadata) {
        continue;
      }
      for (const detail of entry.userRivalMusicDetailList ?? []) {
        if (detail.level === 10) {
          continue;
        }
        const detailLevel = metadata.charts[detail.level]?.detailLevel ?? null;
        if (detailLevel === null) {
          continue;
        }
        const rowRating = getRating(detailLevel, detail.achievement / 10_000);
        if (!Number.isFinite(rowRating) || rowRating <= 0) {
          continue;
        }
        rows.push({ isNew: metadata.isNew, rating: rowRating });
      }
    }
    if (!rows.length) {
      return null;
    }

    const news = rows
      .filter((row) => row.isNew === true)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 15);
    const olds = rows
      .filter((row) => row.isNew === false)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 35);
    return [...news, ...olds].reduce((sum, row) => sum + row.rating, 0);
  }
}
