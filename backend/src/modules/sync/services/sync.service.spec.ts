import { Types } from 'mongoose';

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
    const diffWrites = harness.scoreChangeModel.bulkWrite.mock.calls.length;
    const repeated = await harness.service.createFromUserMusic(payload);

    expect(repeated?.commitOutcome).toBe('no_change');
    expect(harness.current()?.__v).toBe(version);
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

describe('SyncService.mergeRecentEvents', () => {
  it('merges a uniquely matched FC/FS event through the same CAS path', async () => {
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
    const result = await harness.service.mergeRecentEvents({
      friendCode: '634142510810999',
      sourceId: 'recent-event-job',
      events: [
        {
          songName: 'test-17',
          difficulty: 'master',
          fs: 'fsp',
        },
      ],
    });

    expect(result).toMatchObject({
      eventCount: 1,
      matchedCount: 1,
      updatedCount: 1,
      syncId: 'stable-sync',
    });
    expect(harness.current()?.scores[0].fs).toBe('fsp');
  });

  it('skips an ambiguous title without changing the score version', async () => {
    const harness = createHarness({
      current: {
        scores: [
          {
            musicId: '30',
            cid: '30_3',
            chartIndex: 3,
            type: 'standard',
            dxScore: '1000',
            score: '100.0000%',
            fs: null,
            fc: null,
            rating: 100,
            isNew: false,
          },
          {
            musicId: '10030',
            cid: '10030_3',
            chartIndex: 3,
            type: 'dx',
            dxScore: '1000',
            score: '100.0000%',
            fs: null,
            fc: null,
            rating: 100,
            isNew: true,
          },
        ],
      },
    });
    const result = await harness.service.mergeRecentEvents({
      friendCode: '634142510810999',
      sourceId: 'ambiguous-event',
      events: [
        {
          songName: 'duplicate-title',
          difficulty: 'master',
          fc: 'ap',
        },
      ],
    });

    expect(result).toMatchObject({
      matchedCount: 0,
      updatedCount: 0,
      syncId: 'stable-sync',
    });
    expect(harness.current()?.__v).toBe(0);
  });
});
