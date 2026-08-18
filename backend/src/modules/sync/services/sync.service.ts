/* eslint-disable max-lines */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { MusicEntity } from '../../music/schemas/music.schema';
import type {
  ChartPayload,
  MusicDocument,
} from '../../music/schemas/music.schema';
import { SyncEntity } from '../schemas/sync.schema';
import type { SyncDocument, SyncScore } from '../schemas/sync.schema';
import {
  ScoreChangeEntity,
  type ScoreChangeField,
  type ScoreChangeSourceType,
  type ScoreChangeValue,
} from '../schemas/score-change.schema';
import type { ScoreChangeDocument } from '../schemas/score-change.schema';
import { getRating, normalizeAchievement } from '../../../common/rating';
import { convertSyncScoresToDivingFishRecords } from '../../../common/prober/diving-fish/converter';
import { uploadRecords as uploadDivingFishRecords } from '../../../common/prober/diving-fish/api';
import { convertSyncScoresToLxnsPayload } from '../../../common/prober/lxns/converter';
import { uploadLxnsScores } from '../../../common/prober/lxns/client';
import { ProberExportMapService } from './prober-export-map.service';
import type {
  SdgbWorkerMusicEntry,
  SdgbWorkerUserMusicDetail,
} from '@maimai-score-hub/shared';

type JobLike = {
  id: string;
  friendCode: string;
  jobType?: string;
  result?: any;
  context?: Record<string, unknown> | null;
};

type MusicRow = MusicEntity & {
  charts?: ChartPayload[];
};

type ScoreSnapshot = SyncScore;
type CurrentSync = SyncEntity & { _id: Types.ObjectId; __v: number };
type ScoreCommitOutcome = 'created' | 'updated' | 'no_change';
type ScoreChangeDraft = {
  musicId: string;
  chartIndex: number;
  type: string;
  before: ScoreChangeValue;
  after: ScoreChangeValue;
  changedFields: ScoreChangeField[];
  achievementDelta: number | null;
  dxScoreDelta: number | null;
  ratingDelta: number | null;
  fcRankDelta: number | null;
  fsRankDelta: number | null;
};
type ScoreCommitBuild<T> = { delta: ScoreSnapshot[]; meta: T };
type ScoreCommitResult<T> = {
  sync: CurrentSync | null;
  outcome: ScoreCommitOutcome;
  changedChartCount: number;
  beforeScoreVersion: number | null;
  afterScoreVersion: number | null;
  meta: T;
};
type SyncForExport = {
  id: string;
  friendCode: string;
  scores?: SyncScore[];
};
export type CurrentExportSnapshot = {
  syncId: string;
  friendCode: string;
  scoreVersion: number;
  scores: SyncScore[];
};
type MusicCache = {
  at: number;
  rows: MusicRow[];
  byId: Map<string, MusicRow>;
  byTitleKey: Map<string, MusicRow>;
  byCid: Map<
    string,
    { music: MusicRow; chart: ChartPayload; chartIndex: number }
  >;
};
type VsScorePayload = {
  dxScore?: string | null;
  score?: string | null;
  fs?: string | null;
  fc?: string | null;
};
type VsScoreRow = {
  category: string;
  type: string;
  title: string;
  chartIndex: number;
  payload: VsScorePayload;
};
type TargetedVsScore = {
  musicId?: unknown;
  dxScore?: unknown;
  score?: unknown;
  fs?: unknown;
  fc?: unknown;
};

// Rank tables for FC / FS — higher index = better. null is below
// everything. Used by mergeScoreKeepBest so re-attempts that didn't
// improve a clear flag don't downgrade the user's PB.
const FC_RANK = ['fc', 'fcp', 'ap', 'app'] as const;
const FS_RANK = ['fs', 'fsp', 'fdx', 'fdxp'] as const;

function rankIdx(table: readonly string[], v: string | null): number {
  if (v === null) {
    return -1;
  }
  const i = table.indexOf(v);
  return i < 0 ? -1 : i;
}
function pickHigher(
  table: readonly string[],
  a: string | null,
  b: string | null,
): string | null {
  return rankIdx(table, b) > rankIdx(table, a) ? b : a;
}
/** Parse a numeric score string. dxScore is plain int, score is "100.3107%". */
function numScore(v: string | null): number {
  if (v === null) {
    return -Infinity;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : -Infinity;
}
function pickHigherNumeric(a: string | null, b: string | null): string | null {
  return numScore(b) > numScore(a) ? b : a;
}

function validObservation(value: unknown): Date | null {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function latestObservation(
  previous: Date | null,
  incoming: Date | null,
): Date | null {
  if (!previous) {
    return incoming;
  }
  if (!incoming) {
    return previous;
  }
  return previous.getTime() >= incoming.getTime() ? previous : incoming;
}

function hasBestValueChange(
  previous: ScoreSnapshot,
  next: ScoreSnapshot,
): boolean {
  return (
    previous.score !== next.score ||
    previous.dxScore !== next.dxScore ||
    previous.fc !== next.fc ||
    previous.fs !== next.fs
  );
}

/**
 * Merge two score snapshots for the same (musicId, chartIndex), keeping
 * the better of each per-attempt field. Identity fields (musicId, cid,
 * chartIndex, type, rating, isNew) come from the newer snapshot since
 * those reflect the latest chart metadata.
 */
function mergeScoreKeepBest(
  old: ScoreSnapshot,
  fresh: ScoreSnapshot,
): ScoreSnapshot {
  const score = pickHigherNumeric(old.score, fresh.score);
  const merged: ScoreSnapshot = {
    ...fresh,
    dxScore: pickHigherNumeric(old.dxScore, fresh.dxScore),
    score,
    fc: pickHigher(FC_RANK, old.fc, fresh.fc),
    fs: pickHigher(FS_RANK, old.fs, fresh.fs),
    rating: score === fresh.score ? fresh.rating : old.rating,
  };
  const previousObservedAt = validObservation(old.observedAt);
  const freshObservedAt = validObservation(fresh.observedAt);
  let observedAt = previousObservedAt;
  if (!observedAt) {
    observedAt = freshObservedAt;
  } else if (hasBestValueChange(old, merged)) {
    observedAt = latestObservation(previousObservedAt, freshObservedAt);
  }
  if (observedAt) {
    merged.observedAt = observedAt;
  } else {
    delete merged.observedAt;
  }
  return merged;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private musicCache: MusicCache | null = null;

  constructor(
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    @InjectModel(ScoreChangeEntity.name)
    private readonly scoreChangeModel: Model<ScoreChangeDocument>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
    private readonly proberExportMap: ProberExportMapService,
  ) {}

  async createFromJob(job: JobLike) {
    if (job.jobType && job.jobType !== 'update_score') {
      return null;
    }
    if (!job.result) {
      return null;
    }

    const delta = await this.mapResultToScores(job.result);
    if (!delta.length) {
      this.logger.warn(
        `No scores mapped for job ${job.id}; skipping sync write.`,
      );
      return null;
    }

    const committed = await this.commitScoreDelta({
      friendCode: job.friendCode,
      sourceType:
        job.context?.autoUpdateFcfs === true
          ? 'auto_update_fcfs'
          : 'dxnet_update_score',
      sourceId: job.id,
      buildDelta: () => ({ delta, meta: null }),
    });
    return committed.sync
      ? {
          ...committed.sync,
          commitOutcome: committed.outcome,
          changedChartCount: committed.changedChartCount,
        }
      : null;
  }

  async createFromRivalMusic(input: {
    friendCode: string;
    sourceId: string;
    music: SdgbWorkerMusicEntry[];
  }) {
    const delta = await this.mapRivalMusicToScores(input.music);
    if (!delta.length) {
      this.logger.warn(
        `No scores mapped for rival source ${input.sourceId}; skipping sync write.`,
      );
      return null;
    }

    const committed = await this.commitScoreDelta({
      friendCode: input.friendCode,
      sourceType: 'auto_update_rival',
      sourceId: input.sourceId,
      buildDelta: () => ({ delta, meta: null }),
    });
    return committed.sync
      ? {
          ...committed.sync,
          commitOutcome: committed.outcome,
          changedChartCount: committed.changedChartCount,
        }
      : null;
  }

  async createFromUserMusic(input: {
    friendCode: string;
    sourceId: string;
    musicDetails: SdgbWorkerUserMusicDetail[];
    ownerUserId?: string | null;
  }) {
    const delta = await this.mapUserMusicToScores(input.musicDetails);
    if (!delta.length) {
      this.logger.warn(
        `No scores mapped for user-music source ${input.sourceId}; skipping sync write.`,
      );
      return null;
    }

    const committed = await this.commitScoreDelta({
      friendCode: input.friendCode,
      ownerUserId: input.ownerUserId,
      sourceType: 'cabinet_qr_update',
      sourceId: input.sourceId,
      buildDelta: () => ({ delta, meta: null }),
    });
    return committed.sync
      ? {
          ...committed.sync,
          commitOutcome: committed.outcome,
          changedChartCount: committed.changedChartCount,
        }
      : null;
  }

  // Keep the read/build/CAS/retry sequence contiguous; splitting it makes it
  // too easy for a caller to accidentally reuse a stale merge after conflict.
  // eslint-disable-next-line max-lines-per-function
  private async commitScoreDelta<T>(input: {
    friendCode: string;
    ownerUserId?: string | null;
    sourceType: ScoreChangeSourceType;
    sourceId: string;
    buildDelta: (
      currentScores: readonly SyncScore[],
    ) => ScoreCommitBuild<T> | Promise<ScoreCommitBuild<T>>;
  }): Promise<ScoreCommitResult<T>> {
    const ownerUserId = this.toOwnerUserId(input.ownerUserId);

    for (let attempt = 1; attempt <= 8; attempt++) {
      const current = await this.syncModel
        .findOne({ friendCode: input.friendCode })
        .lean<CurrentSync | null>();
      const built = await input.buildDelta(current?.scores ?? []);
      const observedAt = new Date();
      const observedDelta = built.delta.map((score) => ({
        ...score,
        observedAt: validObservation(score.observedAt) ?? observedAt,
      }));
      const merged = this.mergeWithPrevious(current?.scores, observedDelta);

      if (!current) {
        if (!merged.length) {
          return {
            sync: null,
            outcome: 'no_change',
            changedChartCount: 0,
            beforeScoreVersion: null,
            afterScoreVersion: null,
            meta: built.meta,
          };
        }

        try {
          const created = await this.syncModel.create({
            id: randomUUID(),
            friendCode: input.friendCode,
            ownerUserId: ownerUserId ?? null,
            jobId: input.sourceId,
            scores: merged,
            lastSourceType: input.sourceType,
            lastSourceId: input.sourceId,
            lastMergedAt: observedAt,
            scoreUpdatedAt: observedAt,
          });
          const sync = created.toObject() as CurrentSync;
          sync.__v = Number.isFinite(sync.__v) ? sync.__v : 0;
          const changes = this.diffScores([], merged);
          await this.recordScoreChangesBestEffort({
            sync,
            ownerUserId: ownerUserId ?? null,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            beforeScoreVersion: null,
            afterScoreVersion: sync.__v,
            observedAt,
            changes,
          });
          return {
            sync,
            outcome: 'created',
            changedChartCount: changes.length,
            beforeScoreVersion: null,
            afterScoreVersion: sync.__v,
            meta: built.meta,
          };
        } catch (error) {
          if (this.isDuplicateKey(error)) {
            await this.waitForCommitRetry(attempt);
            continue;
          }
          throw error;
        }
      }

      const previousScores = current.scores ?? [];
      this.assertMonotonic(previousScores, merged);
      const changes = this.diffScores(previousScores, merged);
      const changedChartKeys = new Set(
        changes.map((change) => this.scoreKey(change)),
      );
      for (const key of this.observationBackfillKeys(previousScores, merged)) {
        changedChartKeys.add(key);
      }
      const changedChartCount = changedChartKeys.size;
      const commonSet: Record<string, unknown> = {
        jobId: input.sourceId,
        lastSourceType: input.sourceType,
        lastSourceId: input.sourceId,
        lastMergedAt: observedAt,
      };
      if (ownerUserId) {
        commonSet.ownerUserId = ownerUserId;
      }

      if (!changedChartCount) {
        const touched = await this.syncModel
          .findOneAndUpdate(
            { _id: current._id, __v: current.__v },
            { $set: commonSet },
            { new: true, runValidators: true },
          )
          .lean<CurrentSync | null>();
        if (touched) {
          return {
            sync: touched,
            outcome: 'no_change',
            changedChartCount: 0,
            beforeScoreVersion: current.__v,
            afterScoreVersion: touched.__v,
            meta: built.meta,
          };
        }
        await this.waitForCommitRetry(attempt);
        continue;
      }

      const updated = await this.syncModel
        .findOneAndUpdate(
          { _id: current._id, __v: current.__v },
          {
            $set: {
              ...commonSet,
              scores: merged,
              scoreUpdatedAt: observedAt,
            },
            $inc: { __v: 1 },
          },
          { new: true, runValidators: true },
        )
        .lean<CurrentSync | null>();
      if (!updated) {
        await this.waitForCommitRetry(attempt);
        continue;
      }

      await this.recordScoreChangesBestEffort({
        sync: updated,
        ownerUserId: ownerUserId ?? updated.ownerUserId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        beforeScoreVersion: current.__v,
        afterScoreVersion: updated.__v,
        observedAt,
        changes,
      });
      return {
        sync: updated,
        outcome: 'updated',
        changedChartCount,
        beforeScoreVersion: current.__v,
        afterScoreVersion: updated.__v,
        meta: built.meta,
      };
    }

    throw new ServiceUnavailableException({
      code: 'SYNC_COMMIT_CONTENTION',
      message: '成绩正在被其他任务更新，请稍后重试',
    });
  }

  async getLatestWithScores(friendCode: string) {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .lean<CurrentSync | null>();

    if (!sync) {
      throw new NotFoundException('No sync found');
    }

    const scores = (Array.isArray(sync.scores) ? sync.scores : []).map(
      (score) => ({
        ...score,
        cid:
          score.musicId +
          '_' +
          (score.chartIndex === 10 ? 0 : score.chartIndex),
      }),
    );

    return {
      id: sync.id,
      createdAt: sync.createdAt,
      updatedAt: sync.updatedAt,
      lastMergedAt: sync.lastMergedAt ?? sync.updatedAt ?? sync.createdAt,
      scoreUpdatedAt: sync.scoreUpdatedAt ?? sync.updatedAt ?? sync.createdAt,
      scoreVersion: sync.__v ?? 0,
      scores,
    };
  }

  async updateAutoExportResultBySyncId(
    syncId: string,
    autoExportResult: {
      divingFish?: { status: string; message?: string } | null;
      lxns?: { status: string; message?: string } | null;
    },
  ) {
    await this.syncModel.updateOne(
      { id: syncId },
      { $set: { autoExportResult } },
    );
  }

  async getLatestSyncId(friendCode: string): Promise<string> {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .select({ id: 1 })
      .lean<{ id: string } | null>();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    return sync.id;
  }

  private mergeWithPrevious(
    previousScores: SyncScore[] | undefined,
    newScores: ScoreSnapshot[],
  ): ScoreSnapshot[] {
    const merged = new Map<string, ScoreSnapshot>();
    if (Array.isArray(previousScores)) {
      for (const s of previousScores) {
        merged.set(`${s.musicId}::${s.chartIndex}`, s);
      }
    }
    for (const s of newScores) {
      const key = `${s.musicId}::${s.chartIndex}`;
      const old = merged.get(key);
      merged.set(key, old ? mergeScoreKeepBest(old, s) : s);
    }
    return [...merged.values()];
  }

  private diffScores(
    beforeScores: readonly SyncScore[],
    afterScores: readonly SyncScore[],
  ): ScoreChangeDraft[] {
    const before = new Map(
      beforeScores.map((score) => [this.scoreKey(score), score] as const),
    );
    const changes: ScoreChangeDraft[] = [];

    for (const after of afterScores) {
      const previous = before.get(this.scoreKey(after));
      const changedFields: ScoreChangeField[] = [];
      if (!previous) {
        changedFields.push('newChart');
        if (after.score !== null) {
          changedFields.push('score');
        }
        if (after.dxScore !== null) {
          changedFields.push('dxScore');
        }
        if (after.fc !== null) {
          changedFields.push('fc');
        }
        if (after.fs !== null) {
          changedFields.push('fs');
        }
        if (after.rating !== null) {
          changedFields.push('rating');
        }
      } else {
        if (previous.score !== after.score) {
          changedFields.push('score');
        }
        if (previous.dxScore !== after.dxScore) {
          changedFields.push('dxScore');
        }
        if (previous.fc !== after.fc) {
          changedFields.push('fc');
        }
        if (previous.fs !== after.fs) {
          changedFields.push('fs');
        }
        if (previous.rating !== after.rating) {
          changedFields.push('rating');
        }
      }
      if (!changedFields.length) {
        continue;
      }

      changes.push({
        musicId: after.musicId,
        chartIndex: after.chartIndex,
        type: after.type,
        before: this.toScoreChangeValue(previous),
        after: this.toScoreChangeValue(after),
        changedFields,
        achievementDelta: this.numericDelta(previous?.score, after.score),
        dxScoreDelta: this.numericDelta(previous?.dxScore, after.dxScore),
        ratingDelta: this.numberDelta(previous?.rating, after.rating),
        fcRankDelta: this.rankDelta(FC_RANK, previous?.fc, after.fc),
        fsRankDelta: this.rankDelta(FS_RANK, previous?.fs, after.fs),
      });
    }
    return changes;
  }

  private observationBackfillKeys(
    beforeScores: readonly SyncScore[],
    afterScores: readonly SyncScore[],
  ): Set<string> {
    const before = new Map(
      beforeScores.map((score) => [this.scoreKey(score), score] as const),
    );
    const backfilled = new Set<string>();
    for (const after of afterScores) {
      const key = this.scoreKey(after);
      const previous = before.get(key);
      if (
        previous &&
        !validObservation(previous.observedAt) &&
        validObservation(after.observedAt)
      ) {
        backfilled.add(key);
      }
    }
    return backfilled;
  }

  private assertMonotonic(
    beforeScores: readonly SyncScore[],
    afterScores: readonly SyncScore[],
  ): void {
    const after = new Map(
      afterScores.map((score) => [this.scoreKey(score), score] as const),
    );
    for (const previous of beforeScores) {
      const next = after.get(this.scoreKey(previous));
      if (!next) {
        throw new Error(`score merge removed chart ${this.scoreKey(previous)}`);
      }
      if (
        numScore(next.score) < numScore(previous.score) ||
        numScore(next.dxScore) < numScore(previous.dxScore) ||
        rankIdx(FC_RANK, next.fc) < rankIdx(FC_RANK, previous.fc) ||
        rankIdx(FS_RANK, next.fs) < rankIdx(FS_RANK, previous.fs)
      ) {
        throw new Error(
          `score merge regressed chart ${this.scoreKey(previous)}`,
        );
      }
    }
  }

  private async recordScoreChangesBestEffort(input: {
    sync: CurrentSync;
    ownerUserId: Types.ObjectId | null;
    sourceType: ScoreChangeSourceType;
    sourceId: string;
    beforeScoreVersion: number | null;
    afterScoreVersion: number;
    observedAt: Date;
    changes: ScoreChangeDraft[];
  }): Promise<void> {
    if (!input.changes.length) {
      return;
    }
    const changeSetId = randomUUID();

    try {
      for (let offset = 0; offset < input.changes.length; offset += 500) {
        const batch = input.changes.slice(offset, offset + 500);
        await this.scoreChangeModel.bulkWrite(
          batch.map((change) => ({
            updateOne: {
              filter: {
                sourceType: input.sourceType,
                sourceId: input.sourceId,
                musicId: change.musicId,
                chartIndex: change.chartIndex,
              },
              update: {
                $setOnInsert: {
                  id: randomUUID(),
                  changeSetId,
                  friendCode: input.sync.friendCode,
                  ownerUserId: input.ownerUserId,
                  observedAt: input.observedAt,
                  sourceType: input.sourceType,
                  sourceId: input.sourceId,
                  syncId: input.sync.id,
                  beforeScoreVersion: input.beforeScoreVersion,
                  afterScoreVersion: input.afterScoreVersion,
                  ...change,
                  createdAt: input.observedAt,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      }
    } catch (error) {
      this.logger.warn(
        `best-effort score diff write failed source=${input.sourceType}/${input.sourceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private scoreKey(score: Pick<SyncScore, 'musicId' | 'chartIndex'>): string {
    return `${score.musicId}::${score.chartIndex}`;
  }

  private toScoreChangeValue(score: SyncScore | undefined): ScoreChangeValue {
    if (!score) {
      return {};
    }
    return {
      score: score.score,
      dxScore: score.dxScore,
      fc: score.fc,
      fs: score.fs,
      rating: score.rating,
    };
  }

  private numericDelta(
    before: string | null | undefined,
    after: string | null | undefined,
  ): number | null {
    if (after === null || after === undefined) {
      return null;
    }
    const next = Number.parseFloat(after);
    if (!Number.isFinite(next)) {
      return null;
    }
    if (before === null || before === undefined) {
      return next;
    }
    const previous = Number.parseFloat(before);
    return Number.isFinite(previous) ? next - previous : null;
  }

  private numberDelta(
    before: number | null | undefined,
    after: number | null | undefined,
  ): number | null {
    if (after === null || after === undefined) {
      return null;
    }
    return after - (before ?? 0);
  }

  private rankDelta(
    table: readonly string[],
    before: string | null | undefined,
    after: string | null | undefined,
  ): number | null {
    if (after === null || after === undefined) {
      return null;
    }
    return rankIdx(table, after) - rankIdx(table, before ?? null);
  }

  private toOwnerUserId(
    value: string | null | undefined,
  ): Types.ObjectId | null {
    if (!value) {
      return null;
    }
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException('ownerUserId must be a valid ObjectId');
    }
    return new Types.ObjectId(value);
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  private async waitForCommitRetry(attempt: number): Promise<void> {
    const maxDelay = Math.min(200, 10 * 2 ** (attempt - 1));
    const delay = Math.max(1, Math.round(maxDelay * (0.5 + Math.random())));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async getMusicCache(): Promise<MusicCache> {
    const now = Date.now();
    if (this.musicCache && now - this.musicCache.at < 5 * 60 * 1000) {
      return this.musicCache;
    }

    const rows = (await this.musicModel.find().lean()) as MusicRow[];
    const byId = new Map<string, MusicRow>();
    const byTitleKey = new Map<string, MusicRow>();
    const byCid = new Map<
      string,
      { music: MusicRow; chart: ChartPayload; chartIndex: number }
    >();
    for (const m of rows) {
      byId.set(String(m.id), m);
      const categoryKey = m.category ?? '';
      byTitleKey.set(`${categoryKey}::${m.title}::${m.type}`, m);
      if (Array.isArray(m.charts)) {
        m.charts.forEach((chart, index) => {
          if (chart?.cid) {
            byCid.set(chart.cid, {
              music: m,
              chart,
              chartIndex: m.type === 'utage' ? 10 : index,
            });
          }
        });
      }
    }

    this.musicCache = { at: now, rows, byId, byTitleKey, byCid };
    return this.musicCache;
  }

  private async mapResultToScores(result: unknown): Promise<ScoreSnapshot[]> {
    if (!result || typeof result !== 'object') {
      return [];
    }

    const cache = await this.getMusicCache();
    const targeted = (result as { targetedScores?: unknown }).targetedScores;
    if (Array.isArray(targeted)) {
      return targeted.flatMap((row) => {
        const score = this.mapTargetedVsScore(row, cache.byCid);
        return score ? [score] : [];
      });
    }
    const { byTitleKey: musicMap } = cache;
    const scores: ScoreSnapshot[] = [];
    for (const row of this.iterVsScoreRows(result)) {
      const score = this.mapVsScoreRow(row, musicMap);
      if (score) {
        scores.push(score);
      }
    }

    return scores;
  }

  private *iterVsScoreRows(result: object): Generator<VsScoreRow> {
    const categoryMap = result as Record<
      string,
      Record<string, Record<string, Record<string, VsScorePayload>>>
    >;
    for (const [category, typeMap] of Object.entries(categoryMap)) {
      if (!typeMap || typeof typeMap !== 'object') {
        continue;
      }
      yield* this.iterVsTypeRows(category, typeMap);
    }
  }

  private *iterVsTypeRows(
    category: string,
    typeMap: Record<string, Record<string, Record<string, VsScorePayload>>>,
  ): Generator<VsScoreRow> {
    for (const [type, songs] of Object.entries(typeMap)) {
      if (!songs || typeof songs !== 'object') {
        continue;
      }
      yield* this.iterVsSongRows(category, type, songs);
    }
  }

  private *iterVsSongRows(
    category: string,
    type: string,
    songs: Record<string, Record<string, VsScorePayload>>,
  ): Generator<VsScoreRow> {
    for (const [title, charts] of Object.entries(songs)) {
      if (!charts || typeof charts !== 'object') {
        continue;
      }
      for (const [indexStr, payload] of Object.entries(charts)) {
        const chartIndex = Number(indexStr);
        if (!Number.isNaN(chartIndex)) {
          yield { category, type, title, chartIndex, payload };
        }
      }
    }
  }

  private mapVsScoreRow(
    row: VsScoreRow,
    musicMap: Map<string, MusicRow>,
  ): ScoreSnapshot | null {
    const dxScoreFromVS = row.payload.dxScore ?? null;
    const scoreFromVS = row.payload.score ?? null;
    if (
      dxScoreFromVS === null &&
      scoreFromVS === null &&
      (row.payload.fc === null || row.payload.fc === undefined) &&
      (row.payload.fs === null || row.payload.fs === undefined)
    ) {
      return null;
    }
    const resolvedTitle = row.title.length === 0 ? '\u3000' : row.title;
    const music = musicMap.get(
      `${row.category || ''}::${resolvedTitle}::${row.type}`,
    );
    if (!music) {
      this.logger.warn(
        `No music found for score: category="${row.category}", type="${row.type}", title="${resolvedTitle}, key="${row.category || ''}::${resolvedTitle}::${row.type}"`,
      );
      return null;
    }
    const chart = this.resolveChartForIndex(music, row.chartIndex);
    if (!chart?.cid) {
      this.logger.warn(
        `No chart found for score: category="${row.category}", type="${row.type}", title="${row.title}", chartIndex=${row.chartIndex}`,
      );
      return null;
    }
    return this.buildScoreSnapshot(
      row,
      music,
      chart,
      dxScoreFromVS,
      scoreFromVS,
    );
  }

  private mapTargetedVsScore(
    input: unknown,
    byCid: ReadonlyMap<
      string,
      { music: MusicRow; chart: ChartPayload; chartIndex: number }
    >,
  ): ScoreSnapshot | null {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const row = input as TargetedVsScore;
    if (typeof row.musicId !== 'string') {
      return null;
    }
    const reference = byCid.get(row.musicId);
    if (!reference) {
      this.logger.warn(`No chart found for targeted score: ${row.musicId}`);
      return null;
    }
    const dxScore = typeof row.dxScore === 'string' ? row.dxScore : null;
    const score = typeof row.score === 'string' ? row.score : null;
    const fc = typeof row.fc === 'string' ? row.fc : null;
    const fs = typeof row.fs === 'string' ? row.fs : null;
    if (dxScore === null && score === null && fc === null && fs === null) {
      return null;
    }
    const achievement = normalizeAchievement(score);
    const detailLevel = reference.chart.detailLevel ?? null;
    return {
      musicId: reference.music.id,
      cid: row.musicId,
      chartIndex: reference.chartIndex,
      type: reference.music.type,
      dxScore,
      score,
      fc,
      fs,
      rating:
        detailLevel !== null && achievement !== null
          ? getRating(detailLevel, achievement)
          : null,
      isNew: reference.music.isNew ?? null,
    };
  }

  private resolveChartForIndex(
    music: MusicRow,
    chartIndex: number,
  ): ChartPayload | undefined {
    return Array.isArray(music.charts)
      ? (music.charts[chartIndex === 10 ? 0 : chartIndex] as
          | ChartPayload
          | undefined)
      : undefined;
  }

  private buildScoreSnapshot(
    row: VsScoreRow,
    music: MusicRow,
    chart: ChartPayload,
    dxScoreFromVS: string | null,
    scoreFromVS: string | null,
  ): ScoreSnapshot {
    const achievement = normalizeAchievement(scoreFromVS);
    const musicDetailLevel = chart.detailLevel ?? null;
    const rating =
      musicDetailLevel !== null && achievement !== null
        ? getRating(musicDetailLevel, achievement)
        : null;
    return {
      musicId: music.id,
      cid: music.id + '_' + (row.chartIndex === 10 ? 0 : row.chartIndex),
      chartIndex: row.chartIndex,
      type: row.type,
      dxScore: dxScoreFromVS,
      score: scoreFromVS,
      fs: row.payload.fs ?? null,
      fc: row.payload.fc ?? null,
      rating,
      isNew: music.isNew ?? null,
    };
  }

  private async mapRivalMusicToScores(
    rivalMusic: SdgbWorkerMusicEntry[],
  ): Promise<ScoreSnapshot[]> {
    if (!Array.isArray(rivalMusic) || !rivalMusic.length) {
      return [];
    }

    const { byId: musicMap } = await this.getMusicCache();
    const scores: ScoreSnapshot[] = [];

    for (const entry of rivalMusic) {
      const music = musicMap.get(String(entry.musicId));
      if (!music) {
        continue;
      }

      for (const detail of entry.userRivalMusicDetailList ?? []) {
        const chartIndex = detail.level;
        const chart = Array.isArray(music.charts)
          ? (music.charts[chartIndex === 10 ? 0 : chartIndex] as
              | ChartPayload
              | undefined)
          : undefined;
        if (!chart || chart.cid === undefined || chart.cid === null) {
          continue;
        }

        const score = (detail.achievement / 10000).toFixed(4) + '%';
        const achievement = normalizeAchievement(score);
        const musicDetailLevel = chart.detailLevel ?? null;
        const rating =
          musicDetailLevel !== null && achievement !== null
            ? getRating(musicDetailLevel, achievement)
            : null;

        scores.push({
          musicId: music.id,
          cid: music.id + '_' + (chartIndex === 10 ? 0 : chartIndex),
          chartIndex,
          type: music.type ?? '',
          dxScore: String(detail.deluxscoreMax),
          score,
          fs: null,
          fc: null,
          rating,
          isNew: music.isNew ?? null,
        });
      }
    }

    return scores;
  }

  private async mapUserMusicToScores(
    details: SdgbWorkerUserMusicDetail[],
  ): Promise<ScoreSnapshot[]> {
    if (!Array.isArray(details) || !details.length) {
      return [];
    }

    const { byId: musicMap } = await this.getMusicCache();
    const scores: ScoreSnapshot[] = [];
    for (const detail of details) {
      if (detail.achievement === 0 && detail.deluxscoreMax === 0) {
        continue;
      }
      const music = musicMap.get(String(detail.musicId));
      if (!music) {
        continue;
      }
      const chartIndex = detail.level;
      const chart = this.resolveChartForIndex(music, chartIndex);
      if (!chart || chart.cid === undefined || chart.cid === null) {
        continue;
      }
      const score = (detail.achievement / 10000).toFixed(4) + '%';
      const normalized = normalizeAchievement(score);
      const rating =
        chart.detailLevel !== null &&
        chart.detailLevel !== undefined &&
        normalized !== null
          ? getRating(chart.detailLevel, normalized)
          : null;
      scores.push({
        musicId: music.id,
        cid: music.id + '_' + (chartIndex === 10 ? 0 : chartIndex),
        chartIndex,
        type: music.type ?? '',
        dxScore: String(detail.deluxscoreMax),
        score,
        fc: this.mapComboStatus(detail.comboStatus),
        fs: this.mapSyncStatus(detail.syncStatus),
        rating,
        isNew: music.isNew ?? null,
      });
    }
    return this.mergeWithPrevious(undefined, scores);
  }

  private mapComboStatus(value: number): string | null {
    return [null, 'fc', 'fcp', 'ap', 'app'][value] ?? null;
  }

  private mapSyncStatus(value: number): string | null {
    return [null, 'fs', 'fsp', 'fdx', 'fdxp', null][value] ?? null;
  }

  async exportToDivingFish(friendCode: string, importToken: string) {
    const sync = await this.getSyncForExport({ friendCode });
    return this.exportDivingFishSync(sync, importToken);
  }

  async exportSyncToDivingFish(input: {
    friendCode: string;
    syncId: string;
    importToken: string;
  }) {
    const sync = await this.getSyncForExport({
      friendCode: input.friendCode,
      syncId: input.syncId,
    });
    return this.exportDivingFishSync(sync, input.importToken);
  }

  async exportSnapshotToDivingFish(
    snapshot: CurrentExportSnapshot,
    importToken: string,
    signal?: AbortSignal,
  ) {
    return this.exportDivingFishSync(
      {
        id: snapshot.syncId,
        friendCode: snapshot.friendCode,
        scores: snapshot.scores,
      },
      importToken,
      signal,
    );
  }

  private async exportDivingFishSync(
    sync: SyncForExport,
    importToken: string,
    signal?: AbortSignal,
  ) {
    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const exportMap = await this.proberExportMap.getMap();
    const exportableScores = scores.filter((s) =>
      exportMap.toDivingFishId.has(s.musicId),
    );
    if (!exportableScores.length) {
      return {
        status: 'skipped',
        reason: 'no scores supported by diving-fish',
        scores: scores.length,
        exported: 0,
        skipped: scores.length,
      };
    }

    const records = convertSyncScoresToDivingFishRecords(
      exportableScores,
      exportMap.divingFishTitleByDbId,
    );

    try {
      const res = await uploadDivingFishRecords(records, importToken, signal);
      return {
        status: res.status,
        scores: scores.length,
        exported: records.length,
        skipped: scores.length - exportableScores.length,
        response: res.data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      throw new BadRequestException(message);
    }
  }

  async exportToLxns(friendCode: string, importToken: string) {
    const sync = await this.getSyncForExport({ friendCode });
    return this.exportLxnsSync(sync, importToken);
  }

  async exportSyncToLxns(input: {
    friendCode: string;
    syncId: string;
    importToken: string;
  }) {
    const sync = await this.getSyncForExport({
      friendCode: input.friendCode,
      syncId: input.syncId,
    });
    return this.exportLxnsSync(sync, input.importToken);
  }

  async exportSnapshotToLxns(
    snapshot: CurrentExportSnapshot,
    importToken: string,
    signal?: AbortSignal,
  ) {
    return this.exportLxnsSync(
      {
        id: snapshot.syncId,
        friendCode: snapshot.friendCode,
        scores: snapshot.scores,
      },
      importToken,
      signal,
    );
  }

  async getCurrentExportSnapshot(
    friendCode: string,
  ): Promise<CurrentExportSnapshot> {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .select({ id: 1, friendCode: 1, scores: 1, __v: 1 })
      .lean<CurrentSync | null>();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    return {
      syncId: sync.id,
      friendCode: sync.friendCode,
      scoreVersion: sync.__v ?? 0,
      scores: Array.isArray(sync.scores) ? sync.scores : [],
    };
  }

  async getExportVersions(
    friendCodes: string[],
  ): Promise<
    Array<{ friendCode: string; syncId: string; scoreVersion: number }>
  > {
    if (!friendCodes.length) {
      return [];
    }
    const rows = await this.syncModel
      .find({ friendCode: { $in: friendCodes } })
      .select({ _id: 0, friendCode: 1, id: 1, __v: 1 })
      .lean<Array<Pick<CurrentSync, 'friendCode' | 'id' | '__v'>>>();
    return rows.map((row) => ({
      friendCode: row.friendCode,
      syncId: row.id,
      scoreVersion: row.__v ?? 0,
    }));
  }

  private async exportLxnsSync(
    sync: SyncForExport,
    importToken: string,
    signal?: AbortSignal,
  ) {
    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const exportMap = await this.proberExportMap.getMap();
    const exportableScores = scores.filter((s) =>
      exportMap.toLxnsId.has(s.musicId),
    );
    if (!exportableScores.length) {
      return {
        status: 'skipped',
        reason: 'no scores supported by lxns',
        scores: scores.length,
        exported: 0,
        skipped: scores.length,
      };
    }

    const { scores: payload } = convertSyncScoresToLxnsPayload(
      exportableScores,
      exportMap.toLxnsId,
    );
    const res = await uploadLxnsScores(payload, importToken, signal);

    return {
      status: res.status,
      scores: scores.length,
      exported: res.exported,
      skipped: scores.length - exportableScores.length,
      response: res.response,
    };
  }

  private async getSyncForExport(input: {
    friendCode: string;
    syncId?: string;
  }): Promise<SyncForExport> {
    const query = input.syncId
      ? { id: input.syncId, friendCode: input.friendCode }
      : { friendCode: input.friendCode };
    let dbQuery = this.syncModel.findOne(query);
    if (!input.syncId) {
      dbQuery = dbQuery.sort({ createdAt: -1 });
    }
    const sync = await dbQuery.lean<SyncForExport | null>();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    return sync;
  }
}
