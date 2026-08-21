/* eslint-disable max-lines */
import { Types } from 'mongoose';

import { getRating } from '../../../common/rating';
import type { SyncScore } from '../schemas/sync.schema';
import { SyncService } from './sync.service';

type Current = {
  _id: Types.ObjectId;
  __v: number;
  id: string;
  friendCode: string;
  scores: SyncScore[];
  createdAt: Date;
  updatedAt: Date;
  lastMergedAt: Date | null;
  scoreUpdatedAt: Date | null;
  ownerUserId: Types.ObjectId | null;
  jobId: string | null;
  lastSourceType: string | null;
  lastSourceId: string | null;
};

type ScoreChangeSetOnInsert = {
  sourceType: string;
  sourceId: string;
  beforeScoreVersion: number | null;
  afterScoreVersion: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changedFields: string[];
  achievementDelta: number | null;
  dxScoreDelta: number | null;
  fcRankDelta: number | null;
  fsRankDelta: number | null;
};

type ScoreChangeBulkCall = [
  Array<{
    updateOne: { update: { $setOnInsert: ScoreChangeSetOnInsert } };
  }>,
  { ordered: boolean },
];

function cloneCurrent(current: Current | null): Current | null {
  if (!current) {
    return null;
  }
  return {
    ...current,
    scores: current.scores.map((score) => ({ ...score })),
  };
}

function query<T>(value: () => T | Promise<T>) {
  return {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => value()),
  };
}

// The in-memory Mongoose harness intentionally keeps all state transitions in
// one closure so concurrency tests exercise the same CAS document.
// eslint-disable-next-line max-lines-per-function
function createHarness(input?: {
  current?: Partial<Current> | null;
  scoreChangeFailure?: boolean;
  musicRows?: Array<Record<string, unknown>>;
}) {
  let current: Current | null =
    input?.current === null
      ? null
      : ({
          _id: new Types.ObjectId(),
          __v: 0,
          id: 'stable-sync',
          friendCode: '634142510810999',
          scores: [],
          createdAt: new Date('2026-07-18T00:00:00Z'),
          updatedAt: new Date('2026-07-18T00:00:00Z'),
          lastMergedAt: null,
          scoreUpdatedAt: null,
          ownerUserId: null,
          jobId: null,
          lastSourceType: null,
          lastSourceId: null,
          ...(input?.current ?? {}),
        } as Current);
  let barrierRemaining = 0;
  let releaseBarrier: (() => void) | null = null;
  let barrier = Promise.resolve();

  const syncModel = {
    findOne: jest.fn(() =>
      query(async () => {
        const snapshot = cloneCurrent(current);
        if (barrierRemaining > 0) {
          barrierRemaining--;
          if (barrierRemaining === 0) {
            releaseBarrier?.();
          }
          await barrier;
        }
        return snapshot;
      }),
    ),
    findOneAndUpdate: jest.fn(
      (
        filter: { _id: Types.ObjectId; __v: number },
        update: {
          $set?: Partial<Current>;
          $inc?: { __v?: number };
        },
      ) =>
        query(() => {
          if (
            !current ||
            String(current._id) !== String(filter._id) ||
            current.__v !== filter.__v
          ) {
            return null;
          }
          current = {
            ...current,
            ...(update.$set ?? {}),
            __v: current.__v + (update.$inc?.__v ?? 0),
            updatedAt: new Date(),
          };
          return cloneCurrent(current);
        }),
    ),
    create: jest.fn((doc: Partial<Current>) => {
      if (current) {
        const error = new Error('duplicate') as Error & { code: number };
        error.code = 11000;
        throw error;
      }
      current = Object.assign(
        {
          _id: new Types.ObjectId(),
          __v: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastMergedAt: null,
          scoreUpdatedAt: null,
          ownerUserId: null,
          jobId: null,
          lastSourceType: null,
          lastSourceId: null,
          scores: [],
        },
        doc,
      ) as Current;
      const created = cloneCurrent(current)!;
      return { toObject: () => created };
    }),
  };
  const scoreChangeModel = {
    bulkWrite: input?.scoreChangeFailure
      ? jest.fn().mockRejectedValue(new Error('diff unavailable'))
      : jest.fn().mockResolvedValue({ ok: 1 }),
  };
  const musicModel = {
    find: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        input?.musicRows ?? [
          {
            id: '17',
            title: 'test-17',
            type: 'standard',
            category: '舞萌',
            isNew: false,
            charts: [
              {},
              {},
              {},
              { cid: '17_3', detailLevel: 13.5 },
              { cid: '17_4', detailLevel: 14 },
            ],
          },
          {
            id: '18',
            title: 'test-18',
            type: 'standard',
            category: '舞萌',
            isNew: true,
            charts: [{}, {}, {}, { cid: '18_3', detailLevel: 14 }],
          },
          {
            id: '30',
            title: 'duplicate-title',
            type: 'standard',
            category: '舞萌',
            charts: [{}, {}, {}, { cid: '30_3', detailLevel: 12 }],
          },
          {
            id: '10030',
            title: 'duplicate-title',
            type: 'dx',
            category: '舞萌',
            charts: [{}, {}, {}, { cid: '10030_3', detailLevel: 12 }],
          },
        ],
      ),
    }),
  };
  const service = new SyncService(
    syncModel as never,
    scoreChangeModel as never,
    musicModel as never,
    {} as never,
  );

  return {
    service,
    syncModel,
    scoreChangeModel,
    current: () => cloneCurrent(current),
    armReadBarrier(count: number) {
      barrierRemaining = count;
      barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
    },
  };
}

function cabinetDetail(input: {
  musicId: number;
  level?: number;
  achievement: number;
  dxScore: number;
  comboStatus?: number;
  syncStatus?: number;
}) {
  return {
    musicId: input.musicId,
    level: input.level ?? 3,
    playCount: 1,
    achievement: input.achievement,
    comboStatus: input.comboStatus ?? 0,
    syncStatus: input.syncStatus ?? 0,
    deluxscoreMax: input.dxScore,
    scoreRank: 1,
  };
}

function scoreChangeCalls(
  harness: ReturnType<typeof createHarness>,
): ScoreChangeBulkCall[] {
  return harness.scoreChangeModel.bulkWrite.mock
    .calls as unknown as ScoreChangeBulkCall[];
}

describe('SyncService initial score commit', () => {
  it('creates one current document and maps cabinet fields', async () => {
    const harness = createHarness({ current: null });
    const result = await harness.service.createFromUserMusic({
      friendCode: '634142510810999',
      sourceId: 'cabinet-job',
      musicDetails: [
        cabinetDetail({
          musicId: 17,
          achievement: 1005000,
          dxScore: 1234,
          comboStatus: 4,
          syncStatus: 4,
        }),
      ],
    });

    expect(result).toMatchObject({
      commitOutcome: 'created',
      changedChartCount: 1,
    });
    expect(typeof result?.id).toBe('string');
    expect(result?.scores[0]).toMatchObject({
      score: '100.5000%',
      dxScore: '1234',
      fc: 'app',
      fs: 'fdxp',
    });
    expect(result?.scores[0].observedAt).toBeInstanceOf(Date);
    expect(harness.scoreChangeModel.bulkWrite).toHaveBeenCalledTimes(1);
    const [operations, options] = scoreChangeCalls(harness)[0];
    const inserted = operations[0].updateOne.update.$setOnInsert;
    expect(options).toEqual({ ordered: false });
    expect(inserted).toMatchObject({
      sourceType: 'cabinet_qr_update',
      sourceId: 'cabinet-job',
      beforeScoreVersion: null,
      afterScoreVersion: 0,
      before: {},
      after: {
        score: '100.5000%',
        dxScore: '1234',
        fc: 'app',
        fs: 'fdxp',
      },
      achievementDelta: 100.5,
      dxScoreDelta: 1234,
      fcRankDelta: 4,
      fsRankDelta: 4,
    });
    expect(inserted.changedFields).toEqual([
      'newChart',
      'score',
      'dxScore',
      'fc',
      'fs',
      'rating',
    ]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe('SyncService manual score updates', () => {
  it('creates multiple catalog-backed charts in one commit', async () => {
    const harness = createHarness({ current: null });
    const ownerUserId = new Types.ObjectId();

    const result = await harness.service.createFromManualScores({
      friendCode: '634142510810999',
      ownerUserId: String(ownerUserId),
      scores: [
        {
          musicId: '17',
          chartIndex: 3,
          achievement: 100.5,
          dxScore: 1234,
          fc: 'app',
        },
        {
          musicId: '18',
          chartIndex: 3,
          achievement: 99,
          fs: 'fdx',
        },
      ],
    });

    expect(result).toMatchObject({
      outcome: 'created',
      submittedChartCount: 2,
      changedChartCount: 2,
      scoreCount: 2,
      scoreVersion: 0,
    });
    expect(result.sourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(harness.current()).toMatchObject({ ownerUserId });
    expect(harness.current()?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          musicId: '17',
          cid: '17_3',
          score: '100.5000%',
          dxScore: '1234',
          fc: 'app',
          rating: getRating(13.5, 100.5),
        }),
        expect.objectContaining({
          musicId: '18',
          cid: '18_3',
          score: '99.0000%',
          fs: 'fdx',
          rating: getRating(14, 99),
        }),
      ]),
    );
    const inserted =
      scoreChangeCalls(harness)[0][0][0].updateOne.update.$setOnInsert;
    expect(inserted).toMatchObject({
      sourceType: 'manual_score_update',
      sourceId: result.sourceId,
    });
  });

  it('keeps the best value for each field across duplicate submitted charts', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '1000',
            score: '100.0000%',
            fc: 'fcp',
            fs: 'fdx',
            rating: getRating(13.5, 100),
            isNew: false,
          },
        ],
      },
    });

    const result = await harness.service.createFromManualScores({
      friendCode: '634142510810999',
      ownerUserId: String(new Types.ObjectId()),
      scores: [
        {
          musicId: '17',
          chartIndex: 3,
          achievement: 99,
          dxScore: 1200,
          fc: 'app',
          fs: 'fsp',
        },
        {
          musicId: '17',
          chartIndex: 3,
          achievement: 100.5,
          dxScore: 1100,
          fs: 'fdxp',
        },
      ],
    });

    expect(result).toMatchObject({
      outcome: 'updated',
      submittedChartCount: 2,
      changedChartCount: 1,
      scoreVersion: 1,
    });
    expect(harness.current()?.scores[0]).toMatchObject({
      score: '100.5000%',
      dxScore: '1200',
      fc: 'app',
      fs: 'fdxp',
      rating: getRating(13.5, 100.5),
    });
  });

  it('validates every catalog target before committing the batch', async () => {
    const harness = createHarness();
    const before = harness.current();

    await expect(
      harness.service.createFromManualScores({
        friendCode: '634142510810999',
        ownerUserId: String(new Types.ObjectId()),
        scores: [
          { musicId: '17', chartIndex: 3, achievement: 99 },
          { musicId: 'missing', chartIndex: 3, dxScore: 1000 },
          { musicId: '18', chartIndex: 4, fc: 'fc' },
          { musicId: '17', chartIndex: 10, fs: 'fs' },
        ],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'INVALID_SCORE_TARGETS',
        issues: [
          expect.objectContaining({ index: 1, code: 'MUSIC_NOT_FOUND' }),
          expect.objectContaining({ index: 2, code: 'CHART_NOT_FOUND' }),
          expect.objectContaining({ index: 3, code: 'CHART_NOT_FOUND' }),
        ],
      },
    });
    expect(harness.current()).toEqual(before);
    expect(harness.syncModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns no_change for a lower repeated submission', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '1200',
            score: '100.5000%',
            fc: 'app',
            fs: 'fdxp',
            rating: getRating(13.5, 100.5),
            isNew: false,
            observedAt: new Date('2026-08-21T00:00:00.000Z'),
          },
        ],
      },
    });

    const result = await harness.service.createFromManualScores({
      friendCode: '634142510810999',
      ownerUserId: String(new Types.ObjectId()),
      scores: [
        {
          musicId: '17',
          chartIndex: 3,
          achievement: 99,
          dxScore: 1000,
          fc: 'fcp',
          fs: 'fdx',
        },
      ],
    });

    expect(result).toMatchObject({
      outcome: 'no_change',
      changedChartCount: 0,
      scoreVersion: 0,
    });
    expect(harness.current()?.__v).toBe(0);
    expect(harness.scoreChangeModel.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('SyncService targeted FC/FS update_score results', () => {
  it('maps chart ids directly and preserves achievement and DX score', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '1019',
            score: '100.7833%',
            fs: null,
            fc: null,
            rating: 292,
            isNew: false,
          },
        ],
      },
    });

    const result = await harness.service.createFromJob({
      id: 'targeted-fcfs-job',
      friendCode: '634142510810999',
      jobType: 'update_score',
      context: { autoUpdateFcfs: true },
      result: {
        targetedScores: [{ musicId: '17_3', fc: 'ap', fs: 'fdx' }],
      },
    });

    expect(result?.changedChartCount).toBe(1);
    expect(harness.current()?.scores[0]).toMatchObject({
      cid: '17_3',
      dxScore: '1019',
      score: '100.7833%',
      fc: 'ap',
      fs: 'fdx',
    });
    const change =
      scoreChangeCalls(harness)[0][0][0].updateOne.update.$setOnInsert;
    expect(change.sourceType).toBe('auto_update_fcfs');
    expect(change.changedFields).toEqual(['fc', 'fs']);
  });

  it('accepts a full fcfsOnly aggregate without score fields', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '1019',
            score: '100.7833%',
            fs: null,
            fc: null,
            rating: 292,
            isNew: false,
          },
        ],
      },
    });

    await harness.service.createFromJob({
      id: 'full-fcfs-only-job',
      friendCode: '634142510810999',
      jobType: 'update_score',
      result: {
        舞萌: {
          standard: {
            'test-17': { 3: { level: '13', fc: 'ap', fs: 'fdx' } },
          },
        },
      },
    });

    expect(harness.current()?.scores[0]).toMatchObject({
      dxScore: '1019',
      score: '100.7833%',
      rating: 292,
      fc: 'ap',
      fs: 'fdx',
    });
  });
});

describe('SyncService CAS conflict handling', () => {
  it('re-reads latest and preserves both concurrent deltas after CAS conflict', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '100',
            score: '90.0000%',
            fs: null,
            fc: null,
            rating: 1,
            isNew: false,
          },
        ],
      },
    });
    harness.armReadBarrier(2);

    await Promise.all([
      harness.service.createFromUserMusic({
        friendCode: '634142510810999',
        sourceId: 'qr-a',
        musicDetails: [
          cabinetDetail({
            musicId: 17,
            achievement: 1000000,
            dxScore: 1200,
            comboStatus: 3,
          }),
        ],
      }),
      harness.service.createFromUserMusic({
        friendCode: '634142510810999',
        sourceId: 'qr-b',
        musicDetails: [
          cabinetDetail({
            musicId: 18,
            achievement: 990000,
            dxScore: 1300,
            syncStatus: 4,
          }),
        ],
      }),
    ]);

    expect(harness.current()?.__v).toBe(2);
    expect(harness.current()?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ musicId: '17', fc: 'ap' }),
        expect.objectContaining({ musicId: '18', fs: 'fdxp' }),
      ]),
    );
    // Two winning commits produce two diff writes even though one first CAS
    // attempt lost. The stale candidate diff is never persisted.
    expect(harness.scoreChangeModel.bulkWrite).toHaveBeenCalledTimes(2);
  });
});

// eslint-disable-next-line max-lines-per-function
describe('SyncService score change details', () => {
  it('treats a repeated source delta as a no-op without incrementing __v', async () => {
    const harness = createHarness();
    const payload = {
      friendCode: '634142510810999',
      sourceId: 'same-source',
      musicDetails: [
        cabinetDetail({ musicId: 17, achievement: 990000, dxScore: 800 }),
      ],
    };
    await harness.service.createFromUserMusic(payload);
    const version = harness.current()?.__v;
    const observedAt = harness.current()?.scores[0].observedAt;
    const diffWrites = harness.scoreChangeModel.bulkWrite.mock.calls.length;
    const repeated = await harness.service.createFromUserMusic(payload);

    expect(repeated?.commitOutcome).toBe('no_change');
    expect(harness.current()?.__v).toBe(version);
    expect(harness.current()?.scores[0].observedAt).toEqual(observedAt);
    expect(harness.scoreChangeModel.bulkWrite).toHaveBeenCalledTimes(
      diffWrites,
    );
  });

  it('records before/after values and numeric/rank deltas for one chart', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '900',
            score: '99.0000%',
            fc: 'fc',
            fs: 'fs',
            rating: 100,
            isNew: false,
          },
        ],
      },
    });
    await harness.service.createFromUserMusic({
      friendCode: '634142510810999',
      sourceId: 'single-chart-improvement',
      musicDetails: [
        cabinetDetail({
          musicId: 17,
          achievement: 1000000,
          dxScore: 1200,
          comboStatus: 2,
          syncStatus: 2,
        }),
      ],
    });

    const operation = scoreChangeCalls(harness)[0][0][0];
    const inserted = operation.updateOne.update.$setOnInsert;
    expect(inserted).toMatchObject({
      beforeScoreVersion: 0,
      afterScoreVersion: 1,
      before: {
        score: '99.0000%',
        dxScore: '900',
        fc: 'fc',
        fs: 'fs',
        rating: 100,
      },
      after: {
        score: '100.0000%',
        dxScore: '1200',
        fc: 'fcp',
        fs: 'fsp',
      },
      achievementDelta: 1,
      dxScoreDelta: 300,
      fcRankDelta: 1,
      fsRankDelta: 1,
    });
    expect(inserted.changedFields).toEqual([
      'score',
      'dxScore',
      'fc',
      'fs',
      'rating',
    ]);
  });

  it('preserves observedAt when only the derived rating changes', async () => {
    const observedAt = new Date('2026-07-19T00:00:00.000Z');
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '17',
            cid: '17_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '800',
            score: '99.0000%',
            fc: null,
            fs: null,
            rating: -1,
            isNew: false,
            observedAt,
          },
        ],
      },
    });

    const result = await harness.service.createFromUserMusic({
      friendCode: '634142510810999',
      sourceId: 'rating-only-refresh',
      musicDetails: [
        cabinetDetail({ musicId: 17, achievement: 990000, dxScore: 800 }),
      ],
    });

    expect(result?.commitOutcome).toBe('updated');
    expect(harness.current()?.scores[0].rating).not.toBe(-1);
    expect(harness.current()?.scores[0].observedAt).toEqual(observedAt);
  });

  it('backfills a missing observedAt exactly once without a score diff', async () => {
    jest.useFakeTimers();
    const firstObservation = new Date('2026-07-20T06:00:00.000Z');
    jest.setSystemTime(firstObservation);
    try {
      const harness = createHarness({
        current: {
          scores: [
            {
              musicId: '17',
              cid: '17_3',
              chartIndex: 3,
              type: 'standard',
              dxScore: '800',
              score: '99.0000%',
              fc: null,
              fs: null,
              rating: getRating(13.5, 99),
              isNew: false,
            },
          ],
        },
      });
      const payload = {
        friendCode: '634142510810999',
        sourceId: 'legacy-observation-backfill',
        musicDetails: [
          cabinetDetail({ musicId: 17, achievement: 990000, dxScore: 800 }),
        ],
      };

      const first = await harness.service.createFromUserMusic(payload);
      expect(first?.commitOutcome).toBe('updated');
      expect(first?.changedChartCount).toBe(1);
      expect(harness.current()?.__v).toBe(1);
      expect(harness.current()?.scores[0].observedAt).toEqual(firstObservation);
      expect(harness.scoreChangeModel.bulkWrite).not.toHaveBeenCalled();

      jest.setSystemTime(new Date('2026-07-20T07:00:00.000Z'));
      const repeated = await harness.service.createFromUserMusic({
        ...payload,
        sourceId: 'legacy-observation-backfill-repeat',
      });
      expect(repeated?.commitOutcome).toBe('no_change');
      expect(harness.current()?.__v).toBe(1);
      expect(harness.current()?.scores[0].observedAt).toEqual(firstObservation);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SyncService best-effort score change delivery', () => {
  it('does not fail the score commit when best-effort diff persistence fails', async () => {
    const harness = createHarness({ current: null, scoreChangeFailure: true });
    await expect(
      harness.service.createFromUserMusic({
        friendCode: '634142510810999',
        sourceId: 'diff-failure',
        musicDetails: [
          cabinetDetail({ musicId: 17, achievement: 990000, dxScore: 800 }),
        ],
      }),
    ).resolves.toMatchObject({ commitOutcome: 'created' });
  });

  it('chunks a large initial score diff into unordered batches of 500', async () => {
    const musicRows = Array.from({ length: 501 }, (_, index) => {
      const id = 1000 + index;
      return {
        id: String(id),
        title: `batch-${id}`,
        type: 'standard',
        category: '舞萌',
        isNew: false,
        charts: [{}, {}, {}, { cid: `${id}_3`, detailLevel: 12 }],
      };
    });
    const harness = createHarness({ current: null, musicRows });
    await harness.service.createFromUserMusic({
      friendCode: '634142510810999',
      sourceId: 'large-initial-sync',
      musicDetails: musicRows.map((row) =>
        cabinetDetail({
          musicId: Number(row.id),
          achievement: 990000,
          dxScore: 1000,
        }),
      ),
    });

    expect(harness.scoreChangeModel.bulkWrite).toHaveBeenCalledTimes(2);
    const calls = scoreChangeCalls(harness);
    expect(calls[0][0]).toHaveLength(500);
    expect(calls[1][0]).toHaveLength(1);
    expect(calls.map((call) => call[1])).toEqual([
      { ordered: false },
      { ordered: false },
    ]);
  });
});
