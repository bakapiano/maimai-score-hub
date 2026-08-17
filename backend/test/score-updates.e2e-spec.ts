/* eslint-disable max-lines */
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ScoreChangeHistoryResponseSchema,
  ScoreHistoryCalendarResponseSchema,
  ScoreHistoryFeedResponseSchema,
} from '@maimai-score-hub/shared';

import { MusicEntity } from '../src/modules/music/schemas/music.schema';
import { UserEntity } from '../src/modules/users/schemas/user.schema';
import { SyncEntity } from '../src/modules/sync/schemas/sync.schema';
import { ScoreChangeEntity } from '../src/modules/sync/schemas/score-change.schema';
import { SyncService } from '../src/modules/sync/services/sync.service';
import { ProberExportMapService } from '../src/modules/sync/services/prober-export-map.service';
import { ProberExportService } from '../src/modules/prober-export/services/prober-export.service';
import { ProberExportStateEntity } from '../src/modules/prober-export/schemas/prober-export-state.schema';
import { ProberExportJobEntity } from '../src/modules/prober-export/schemas/prober-export-job.schema';
import { AppModule } from '../src/app.module';
import { CabinetScoreSyncService } from '../src/modules/cabinet-score-sync/cabinet-score-sync.service';
import { AuthService } from '../src/modules/auth/services/auth.service';
import { AccountDeletionService } from '../src/modules/users/services/account-deletion.service';
import { getRating } from '../src/common/rating';
import { countRgbPixelsInRegion } from './png-test-utils';

jest.setTimeout(120_000);

const databaseName = `maimai_score_hub_score_e2e_${process.pid}`;
const redisPrefix = `score-e2e:${process.pid}:`;
const friendCode = '700000000000001';
const exportFriendCode = '700000000000002';
const reconcileFriendCode = '700000000000003';
const lxnsExportFriendCode = '700000000000004';

function cabinetDetail(musicId: number) {
  return {
    musicId,
    level: 3,
    playCount: 1,
    achievement: 990000 + musicId,
    comboStatus: musicId % 4,
    syncStatus: musicId % 5,
    deluxscoreMax: 1000 + musicId,
    scoreRank: 10,
  };
}

function scoreHistoryRow(input: {
  id: string;
  rowFriendCode: string;
  ownerUserId: Types.ObjectId;
  observedAt: string;
  musicId?: string;
  chartIndex?: number;
  type?: string;
}) {
  return {
    id: input.id,
    changeSetId: `set-${input.id}`,
    friendCode: input.rowFriendCode,
    ownerUserId: input.ownerUserId,
    observedAt: new Date(input.observedAt),
    sourceType: 'cabinet_qr_update',
    sourceId: `source-${input.id}`,
    syncId: `sync-${input.rowFriendCode}`,
    beforeScoreVersion: 0,
    afterScoreVersion: 1,
    musicId: input.musicId ?? '17',
    chartIndex: input.chartIndex ?? 3,
    type: input.type ?? 'standard',
    before: { score: '99.0000%' },
    after: { score: '100.0000%' },
    changedFields: ['score'] as ScoreChangeEntity['changedFields'],
    achievementDelta: 1,
    dxScoreDelta: null,
    ratingDelta: null,
    fcRankDelta: null,
    fsRankDelta: null,
  };
}

// A single lifecycle owns two Nest applications and the shared test database.
// eslint-disable-next-line max-lines-per-function
describe('score update concurrency and export ownership (local e2e)', () => {
  let moduleA: TestingModule;
  let moduleB: TestingModule;
  let appA: INestApplication<App>;
  let appB: INestApplication<App>;
  let syncA: SyncService;
  let syncB: SyncService;
  let exportA: ProberExportService;
  let exportB: ProberExportService;
  let cabinetScores: CabinetScoreSyncService;
  let musicModel: Model<MusicEntity>;
  let userModel: Model<UserEntity>;
  let syncModel: Model<SyncEntity>;
  let scoreChangeModel: Model<ScoreChangeEntity>;
  let exportStateModel: Model<ProberExportStateEntity>;
  let exportJobModel: Model<ProberExportJobEntity>;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    Object.assign(process.env, {
      MONGO_HOST: '127.0.0.1',
      MONGO_PORT: '27017',
      MONGO_DB: databaseName,
      MONGO_USER: '',
      MONGO_PASSWORD: '',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_DB: '0',
      REDIS_PASSWORD: '',
      REDIS_KEY_PREFIX: redisPrefix,
      BULLMQ_PREFIX: `${redisPrefix}bull`,
      AUTH_JWT_SECRET: 'score-e2e-secret',
      ADMIN_PASSWORD: 'score-e2e-admin',
      API_SHARED_SECRET: 'score-e2e-admin',
      SKIP_AUTH: 'true',
      OBSERVABILITY_ENABLED: 'false',
      PROBER_EXPORT_RECONCILE_INTERVAL_MS: '3600000',
      PROBER_EXPORT_CONCURRENCY: '1',
    });

    moduleA = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    appA = moduleA.createNestApplication();
    await appA.init();

    musicModel = moduleA.get(getModelToken(MusicEntity.name));
    userModel = moduleA.get(getModelToken(UserEntity.name));
    syncModel = moduleA.get(getModelToken(SyncEntity.name));
    scoreChangeModel = moduleA.get(getModelToken(ScoreChangeEntity.name));
    exportStateModel = moduleA.get(getModelToken(ProberExportStateEntity.name));
    exportJobModel = moduleA.get(getModelToken(ProberExportJobEntity.name));
    await syncModel.db.dropDatabase();
    await Promise.all([
      musicModel.init(),
      userModel.init(),
      syncModel.init(),
      scoreChangeModel.init(),
      exportStateModel.init(),
      exportJobModel.init(),
    ]);

    moduleB = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    appB = moduleB.createNestApplication();
    await appB.init();

    syncA = moduleA.get(SyncService);
    syncB = moduleB.get(SyncService);
    exportA = moduleA.get(ProberExportService);
    exportB = moduleB.get(ProberExportService);
    cabinetScores = moduleA.get(CabinetScoreSyncService);
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await syncModel.db.dropDatabase();
    await appB?.close();
    await appA?.close();
    const redis = createClient({ url: 'redis://127.0.0.1:6379/0' });
    await redis.connect();
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({
      MATCH: `${redisPrefix}*`,
    })) {
      keys.push(...batch);
    }
    if (keys.length) {
      await Promise.all(keys.map((key) => redis.del(key)));
    }
    await redis.quit();
  });

  beforeEach(async () => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    await Promise.all([
      musicModel.deleteMany({}),
      userModel.deleteMany({}),
      syncModel.deleteMany({}),
      scoreChangeModel.deleteMany({}),
      exportStateModel.deleteMany({}),
      exportJobModel.deleteMany({}),
    ]);
    await musicModel.insertMany(
      Array.from({ length: 10 }, (_, index) => {
        const id = 17 + index;
        return {
          id: String(id),
          title: `e2e-${id}`,
          type: 'standard',
          category: '舞萌',
          isNew: id % 2 === 0,
          charts: [{}, {}, {}, { cid: `${id}_3`, detailLevel: 13.5 }],
        };
      }),
    );
  });

  it('merges concurrent deltas from two backend instances into one current sync', async () => {
    await syncA.createFromUserMusic({
      friendCode,
      sourceId: 'initial',
      musicDetails: [cabinetDetail(17)],
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        const service = index % 2 === 0 ? syncA : syncB;
        const musicId = 18 + index;
        return service.createFromUserMusic({
          friendCode,
          sourceId: `concurrent-${musicId}`,
          musicDetails: [cabinetDetail(musicId)],
        });
      }),
    );

    const current = await syncModel.findOne({ friendCode }).lean();
    expect(await syncModel.countDocuments({ friendCode })).toBe(1);
    expect(current?.scores).toHaveLength(9);
    expect(new Set(current?.scores.map((score) => score.musicId)).size).toBe(9);
    expect(current?.__v).toBe(8);
    expect(await scoreChangeModel.countDocuments({ friendCode })).toBe(9);
    const changes = await scoreChangeModel
      .find({ friendCode })
      .sort({ afterScoreVersion: 1 })
      .lean();
    expect(changes.map((change) => change.afterScoreVersion)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(new Set(changes.map((change) => change.sourceId)).size).toBe(9);
    expect(changes.every((change) => change.syncId === current?.id)).toBe(true);
    expect(changes[0]).toMatchObject({
      sourceId: 'initial',
      beforeScoreVersion: null,
    });
    expect(changes[0]?.changedFields).toContain('newChart');
    expect(changes[0]?.changedFields).toContain('score');
    expect(changes[0]?.changedFields).toContain('dxScore');
  });

  it('returns only the authenticated user exact-chart score history with cursor pagination', async () => {
    const owner = await userModel.create({ friendCode });
    const otherFriendCode = '700000000000099';
    const other = await userModel.create({ friendCode: otherFriendCode });
    await scoreChangeModel.insertMany([
      scoreHistoryRow({
        id: 'owned-1',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:01.000Z',
      }),
      scoreHistoryRow({
        id: 'owned-2',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:02.000Z',
      }),
      scoreHistoryRow({
        id: 'owned-3',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:03.000Z',
      }),
      scoreHistoryRow({
        id: 'other-user',
        rowFriendCode: otherFriendCode,
        ownerUserId: other._id,
        observedAt: '2026-01-01T00:00:04.000Z',
      }),
      scoreHistoryRow({
        id: 'other-chart',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:05.000Z',
        chartIndex: 2,
      }),
      scoreHistoryRow({
        id: 'other-type',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:06.000Z',
        type: 'dx',
      }),
    ]);

    const { token } = await moduleA
      .get(AuthService)
      .issueTokenForUser({ _id: owner._id, friendCode: owner.friendCode });
    const first = await request(appA.getHttpServer())
      .get('/me/score-changes')
      .set('Authorization', `Bearer ${token}`)
      .query({ musicId: '17', chartIndex: '3', type: 'standard', limit: '2' })
      .expect(200);
    const firstBody = ScoreChangeHistoryResponseSchema.parse(
      first.body as unknown,
    );

    expect(firstBody.items.map((item) => item.id)).toEqual([
      'owned-3',
      'owned-2',
    ]);
    expect(firstBody.items[0]).toMatchObject({
      musicId: '17',
      chartIndex: 3,
      type: 'standard',
      before: { score: '99.0000%' },
      after: { score: '100.0000%' },
      changedFields: ['score'],
    });
    expect(firstBody.items[0]).not.toHaveProperty('friendCode');
    expect(typeof firstBody.nextCursor).toBe('string');

    const second = await request(appA.getHttpServer())
      .get('/me/score-changes')
      .set('Authorization', `Bearer ${token}`)
      .query({
        musicId: '17',
        chartIndex: '3',
        type: 'standard',
        limit: '2',
        cursor: firstBody.nextCursor ?? '',
      })
      .expect(200);
    const secondBody = ScoreChangeHistoryResponseSchema.parse(
      second.body as unknown,
    );
    expect(secondBody.items.map((item) => item.id)).toEqual(['owned-1']);
    expect(secondBody.nextCursor).toBeNull();

    await request(appA.getHttpServer())
      .get('/me/score-changes')
      .set('Authorization', `Bearer ${token}`)
      .query({
        musicId: '17',
        chartIndex: '3',
        type: 'standard',
        cursor: 'not-a-cursor',
      })
      .expect(400);
    await request(appA.getHttpServer())
      .get('/me/score-changes')
      .query({ musicId: '17', chartIndex: '3', type: 'standard' })
      .expect(401);
  });

  it('filters the authenticated user full score history by integer time window', async () => {
    const owner = await userModel.create({ friendCode });
    const other = await userModel.create({ friendCode: '700000000000097' });
    const inserted = await scoreChangeModel.insertMany([
      scoreHistoryRow({
        id: 'feed-latest',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:06.000Z',
      }),
      scoreHistoryRow({
        id: 'feed-tied-a',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:05.000Z',
        chartIndex: 2,
      }),
      scoreHistoryRow({
        id: 'feed-tied-b',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:05.000Z',
        type: 'dx',
      }),
      scoreHistoryRow({
        id: 'feed-oldest',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:00:04.000Z',
      }),
      scoreHistoryRow({
        id: 'feed-other-user',
        rowFriendCode: other.friendCode,
        ownerUserId: other._id,
        observedAt: '2026-01-01T00:00:07.000Z',
      }),
    ]);
    const expectedIds = inserted
      .filter((row) => row.friendCode === friendCode)
      .sort(
        (a, b) =>
          b.observedAt.getTime() - a.observedAt.getTime() ||
          String(b._id).localeCompare(String(a._id)),
      )
      .map((row) => row.id);
    const { token } = await moduleA
      .get(AuthService)
      .issueTokenForUser({ _id: owner._id, friendCode: owner.friendCode });

    const fullWindowResponse = await request(appA.getHttpServer())
      .get('/me/score-history')
      .set('Authorization', `Bearer ${token}`)
      .query({
        start: Date.parse('2026-01-01T00:00:04.000Z'),
        end: Date.parse('2026-01-01T00:00:07.000Z'),
      })
      .expect(200);
    const fullWindow = ScoreHistoryFeedResponseSchema.parse(
      fullWindowResponse.body as unknown,
    );
    expect(fullWindow.items.map((item) => item.id)).toEqual(expectedIds);
    expect(fullWindow.hasEarlier).toBe(false);

    const recentWindowResponse = await request(appA.getHttpServer())
      .get('/me/score-history')
      .set('Authorization', `Bearer ${token}`)
      .query({
        start: Date.parse('2026-01-01T00:00:05.000Z'),
        end: Date.parse('2026-01-01T00:00:07.000Z'),
      })
      .expect(200);
    const recentWindow = ScoreHistoryFeedResponseSchema.parse(
      recentWindowResponse.body as unknown,
    );
    expect(recentWindow.items.map((item) => item.id)).toEqual(
      expectedIds.slice(0, 3),
    );
    expect(recentWindow.hasEarlier).toBe(true);

    await request(appA.getHttpServer())
      .get('/me/score-history')
      .set('Authorization', `Bearer ${token}`)
      .query({ start: Date.parse('2026-01-01T00:00:05.000Z') })
      .expect(400);
    await request(appA.getHttpServer()).get('/me/score-history').expect(401);
  });

  it('returns every score change in one day without count pagination', async () => {
    const owner = await userModel.create({ friendCode });
    const start = Date.parse('2026-02-01T00:00:00.000Z');
    await scoreChangeModel.insertMany(
      Array.from({ length: 105 }, (_, index) =>
        scoreHistoryRow({
          id: `full-day-${index}`,
          rowFriendCode: friendCode,
          ownerUserId: owner._id,
          observedAt: new Date(start + index * 1000).toISOString(),
        }),
      ),
    );
    const { token } = await moduleA
      .get(AuthService)
      .issueTokenForUser({ _id: owner._id, friendCode: owner.friendCode });

    const response = await request(appA.getHttpServer())
      .get('/me/score-history')
      .set('Authorization', `Bearer ${token}`)
      .query({ start, end: start + 24 * 60 * 60 * 1000 })
      .expect(200);
    const feed = ScoreHistoryFeedResponseSchema.parse(response.body as unknown);

    expect(feed.items).toHaveLength(105);
    expect(feed.items[0]?.id).toBe('full-day-104');
    expect(feed.items.at(-1)?.id).toBe('full-day-0');
    expect(feed.hasEarlier).toBe(false);
  });

  it('merges one business day and exports a four-column history PNG', async () => {
    const owner = await userModel.create({ friendCode });
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    const rows = Array.from({ length: 15 }, (_, index) =>
      scoreHistoryRow({
        id: `history-export-${index}`,
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: new Date(start + (index + 1) * 1000).toISOString(),
        musicId: String(17 + (index % 10)),
        chartIndex: index < 10 ? 3 : 2,
      }),
    );
    rows[0].changedFields = [
      'score',
      'newChart',
    ] as ScoreChangeEntity['changedFields'];
    rows.push(
      scoreHistoryRow({
        id: 'history-export-duplicate',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: new Date(start + 60_000).toISOString(),
        musicId: '17',
        chartIndex: 3,
      }),
    );
    await scoreChangeModel.insertMany(rows);
    const { token } = await moduleA
      .get(AuthService)
      .issueTokenForUser({ _id: owner._id, friendCode: owner.friendCode });

    const response = await request(appA.getHttpServer())
      .get('/me/score-exports/history')
      .set('Authorization', `Bearer ${token}`)
      .query({
        date: '2026-03-01',
        start,
        end: start + 24 * 60 * 60 * 1000,
        timeZone: 'Asia/Shanghai',
        dayStartHour: 6,
      })
      .expect(200)
      .expect('Content-Type', /image\/png/)
      .expect('Content-Disposition', /score-history-2026-03-01\.png/);

    const png = Buffer.from(response.body as Uint8Array);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.readUInt32BE(16)).toBe(3040);
    expect(png.readUInt32BE(20)).toBe(1778);
    const newBadgePixelCount = await countRgbPixelsInRegion(
      png,
      { left: 32, top: 658, width: 720, height: 64 },
      [0xe8, 0xf7, 0xf9],
    );
    expect(newBadgePixelCount).toBeGreaterThan(200);
  });

  it('applies the key-change filter to history exports', async () => {
    const owner = await userModel.create({ friendCode });
    const start = Date.parse('2026-03-02T00:00:00.000Z');
    const quietRow = {
      ...scoreHistoryRow({
        id: 'history-export-no-key-change',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: new Date(start + 1000).toISOString(),
      }),
      after: { score: '99.4000%' },
      achievementDelta: 0.4,
    };
    await scoreChangeModel.create(quietRow);
    const { token } = await moduleA
      .get(AuthService)
      .issueTokenForUser({ _id: owner._id, friendCode: owner.friendCode });
    const query = {
      date: '2026-03-02',
      start,
      end: start + 24 * 60 * 60 * 1000,
      timeZone: 'Asia/Shanghai',
      dayStartHour: 6,
    };

    await request(appA.getHttpServer())
      .get('/me/score-exports/history')
      .set('Authorization', `Bearer ${token}`)
      .query({ ...query, keyChangesOnly: 'false' })
      .expect(200);
    await request(appA.getHttpServer())
      .get('/me/score-exports/history')
      .set('Authorization', `Bearer ${token}`)
      .query({ ...query, keyChangesOnly: 'true' })
      .expect(404);

    const fcRow = {
      ...scoreHistoryRow({
        id: 'history-export-fc-change',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: new Date(start + 2000).toISOString(),
        musicId: '18',
      }),
      before: { score: '99.0000%', fc: null },
      after: { score: '99.4000%', fc: 'fc' },
      changedFields: ['score', 'fc'] as ScoreChangeEntity['changedFields'],
      achievementDelta: 0.4,
      fcRankDelta: 1,
    };
    await scoreChangeModel.create(fcRow);

    await request(appA.getHttpServer())
      .get('/me/score-exports/history')
      .set('Authorization', `Bearer ${token}`)
      .query({ ...query, keyChangesOnly: 'true' })
      .expect(200)
      .expect('Content-Type', /image\/png/);
  });

  it('filters history by time and groups business days in the browser zone', async () => {
    const owner = await userModel.create({ friendCode });
    const other = await userModel.create({ friendCode: '700000000000096' });
    await scoreChangeModel.insertMany([
      scoreHistoryRow({
        id: 'calendar-current-a',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:10:00.000Z',
      }),
      scoreHistoryRow({
        id: 'calendar-current-b',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2026-01-01T00:20:00.000Z',
      }),
      scoreHistoryRow({
        id: 'calendar-before-six',
        rowFriendCode: friendCode,
        ownerUserId: owner._id,
        observedAt: '2025-12-31T21:00:00.000Z',
      }),
      scoreHistoryRow({
        id: 'calendar-other-user',
        rowFriendCode: other.friendCode,
        ownerUserId: other._id,
        observedAt: '2026-01-01T00:30:00.000Z',
      }),
    ]);
    const { token } = await moduleA
      .get(AuthService)
      .issueTokenForUser({ _id: owner._id, friendCode: owner.friendCode });
    const from = Date.parse('2025-12-31T12:00:00.000Z');
    const to = Date.parse('2026-01-01T12:00:00.000Z');

    const calendarResponse = await request(appA.getHttpServer())
      .get('/me/score-history/calendar')
      .set('Authorization', `Bearer ${token}`)
      .query({ from, to, timeZone: 'Asia/Shanghai', dayStartHour: 6 })
      .expect(200);
    const calendar = ScoreHistoryCalendarResponseSchema.parse(
      calendarResponse.body as unknown,
    );
    expect(calendar).toEqual({
      days: [
        { day: '2026-01-01', count: 2 },
        { day: '2025-12-31', count: 1 },
      ],
      hasEarlier: false,
    });

    const feedResponse = await request(appA.getHttpServer())
      .get('/me/score-history')
      .set('Authorization', `Bearer ${token}`)
      .query({
        start: Date.parse('2026-01-01T00:00:00.000Z'),
        end: Date.parse('2026-01-01T01:00:00.000Z'),
      })
      .expect(200);
    const feed = ScoreHistoryFeedResponseSchema.parse(
      feedResponse.body as unknown,
    );
    expect(feed.items.map((item) => item.id)).toEqual([
      'calendar-current-b',
      'calendar-current-a',
    ]);
    expect(feed.hasEarlier).toBe(true);

    await request(appA.getHttpServer())
      .get('/me/score-history/calendar')
      .set('Authorization', `Bearer ${token}`)
      .query({ from, to, timeZone: 'Not/A_Real_Zone', dayStartHour: 6 })
      .expect(400);
  });

  it('deletes score change history with the owning account', async () => {
    const deleteFriendCode = '700000000000098';
    const user = await userModel.create({ friendCode: deleteFriendCode });
    await scoreChangeModel.create(
      scoreHistoryRow({
        id: 'account-delete-history',
        rowFriendCode: deleteFriendCode,
        ownerUserId: user._id,
        observedAt: '2026-01-01T00:00:01.000Z',
      }),
    );

    const result = await moduleA
      .get(AccountDeletionService)
      .deleteAccount(String(user._id));

    expect(result.deleted.scoreChanges).toBe(1);
    expect(
      await scoreChangeModel.countDocuments({ friendCode: deleteFriendCode }),
    ).toBe(0);
    expect(
      await userModel.countDocuments({ friendCode: deleteFriendCode }),
    ).toBe(0);
  });

  it('allows only one backend instance to own a user export at a time', async () => {
    await userModel.create({
      friendCode: exportFriendCode,
      divingFishImportToken: 'e2e-token',
      lxnsImportToken: null,
    });
    await syncA.createFromUserMusic({
      friendCode: exportFriendCode,
      sourceId: 'export-sync',
      musicDetails: [cabinetDetail(17)],
    });
    await exportStateModel.create({
      friendCode: exportFriendCode,
      providers: {
        divingFish: {
          enabled: true,
          lastSuccessVersion: null,
          lastAttemptVersion: null,
          status: 'idle',
          nextAttemptAt: null,
          error: null,
          result: null,
          updatedAt: null,
        },
        lxns: {
          enabled: false,
          lastSuccessVersion: null,
          lastAttemptVersion: null,
          status: 'idle',
          nextAttemptAt: null,
          error: null,
          result: null,
          updatedAt: null,
        },
      },
    });

    const exportMap = {
      toDivingFishId: new Map([['17', '17']]),
      toLxnsId: new Map<string, string>(),
      divingFishTitleByDbId: new Map([['17', 'e2e-17']]),
    };
    jest
      .spyOn(moduleA.get(ProberExportMapService), 'getMap')
      .mockResolvedValue(exportMap);
    jest
      .spyOn(moduleB.get(ProberExportMapService), 'getMap')
      .mockResolvedValue(exportMap);

    let activeUploads = 0;
    let maxActiveUploads = 0;
    let releaseUpload: () => void = () => {};
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const target =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (!target.includes('/player/update_records')) {
        throw new Error(`unexpected e2e fetch ${target}`);
      }
      activeUploads++;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      markStarted?.();
      await blocked;
      activeUploads--;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const first = exportA.processDelivery({
      kind: 'auto',
      friendCode: exportFriendCode,
    });
    await started;
    const second = await exportB.processDelivery({
      kind: 'auto',
      friendCode: exportFriendCode,
    });
    expect(second.kind).toBe('lease_busy');
    releaseUpload();
    await expect(first).resolves.toEqual({ kind: 'done' });

    const state = await exportStateModel
      .findOne({ friendCode: exportFriendCode })
      .lean();
    expect(maxActiveUploads).toBe(1);
    expect(state?.claimToken).toBeNull();
    expect(state?.providers.divingFish.lastSuccessVersion).toBe(0);
    expect(
      await exportJobModel.countDocuments({
        friendCode: exportFriendCode,
        kind: 'auto',
      }),
    ).toBe(1);
  });

  // eslint-disable-next-line max-lines-per-function
  it('backfills one legacy observation and omits untouched play_time', async () => {
    await userModel.create({
      friendCode: lxnsExportFriendCode,
      divingFishImportToken: null,
      lxnsImportToken: 'lxns-e2e-token',
    });
    const created = await syncA.createFromUserMusic({
      friendCode: lxnsExportFriendCode,
      sourceId: 'lxns-observed-sync',
      musicDetails: [cabinetDetail(17)],
    });
    const observedAt = created?.scores[0].observedAt;
    expect(observedAt).toBeInstanceOf(Date);

    const legacyScores = [18, 19].map((musicId) => ({
      musicId: String(musicId),
      cid: `${musicId}_3`,
      chartIndex: 3,
      type: 'standard',
      dxScore: String(1000 + musicId),
      score: '99.0000%',
      fs: null,
      fc: null,
      rating: getRating(13.5, 99),
      isNew: false,
    }));
    const currentSync = await syncModel
      .findOne({ friendCode: lxnsExportFriendCode })
      .lean();
    await syncModel.updateOne(
      { friendCode: lxnsExportFriendCode },
      {
        $set: { scores: [...(currentSync?.scores ?? []), ...legacyScores] },
        $inc: { __v: 1 },
      },
    );
    const backfilled = await syncA.createFromUserMusic({
      friendCode: lxnsExportFriendCode,
      sourceId: 'lxns-legacy-observation-backfill',
      musicDetails: [
        {
          musicId: 18,
          level: 3,
          playCount: 1,
          achievement: 990000,
          comboStatus: 0,
          syncStatus: 0,
          deluxscoreMax: 1018,
          scoreRank: 10,
        },
      ],
    });
    const backfilledAt = backfilled?.scores.find(
      (score) => score.musicId === '18',
    )?.observedAt;
    expect(backfilled?.changedChartCount).toBe(1);
    expect(backfilledAt).toBeInstanceOf(Date);
    await exportStateModel.create({
      friendCode: lxnsExportFriendCode,
      providers: {
        divingFish: {
          enabled: false,
          lastSuccessVersion: null,
          lastAttemptVersion: null,
          status: 'idle',
          nextAttemptAt: null,
          error: null,
          result: null,
          updatedAt: null,
        },
        lxns: {
          enabled: true,
          lastSuccessVersion: null,
          lastAttemptVersion: null,
          status: 'idle',
          nextAttemptAt: null,
          error: null,
          result: null,
          updatedAt: null,
        },
      },
    });
    const exportMap = {
      toDivingFishId: new Map<string, string>(),
      toLxnsId: new Map([
        ['17', '17'],
        ['18', '18'],
        ['19', '19'],
      ]),
      divingFishTitleByDbId: new Map<string, string>(),
    };
    jest
      .spyOn(moduleA.get(ProberExportMapService), 'getMap')
      .mockResolvedValue(exportMap);

    let uploaded: {
      scores: Array<{ id: number; play_time?: string }>;
    } | null = null;
    global.fetch = jest.fn(
      (url: string | URL | Request, init?: RequestInit) => {
        const target =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (!target.endsWith('/api/v0/user/maimai/player/scores')) {
          throw new Error(`unexpected e2e fetch ${target}`);
        }
        if (typeof init?.body !== 'string') {
          throw new Error('LXNS e2e upload body was not JSON text');
        }
        uploaded = JSON.parse(init.body) as typeof uploaded;
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, code: 200 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    ) as typeof fetch;

    await expect(
      exportA.processDelivery({
        kind: 'auto',
        friendCode: lxnsExportFriendCode,
      }),
    ).resolves.toEqual({ kind: 'done' });

    expect(uploaded).not.toBeNull();
    const byId = new Map(uploaded!.scores.map((score) => [score.id, score]));
    expect(byId.get(17)?.play_time).toBe(observedAt?.toISOString());
    expect(byId.get(18)?.play_time).toBe(backfilledAt?.toISOString());
    expect(byId.get(19)).not.toHaveProperty('play_time');
  });

  it('repairs a missing wake by reconciling state version against current sync', async () => {
    await userModel.create({
      friendCode: reconcileFriendCode,
      divingFishImportToken: 'reconcile-token',
      lxnsImportToken: null,
    });
    await syncA.createFromUserMusic({
      friendCode: reconcileFriendCode,
      sourceId: 'reconcile-sync',
      musicDetails: [cabinetDetail(17)],
    });
    await exportStateModel.create({
      friendCode: reconcileFriendCode,
      nextReconcileAt: new Date(0),
      providers: {
        divingFish: {
          enabled: true,
          lastSuccessVersion: null,
          lastAttemptVersion: null,
          status: 'idle',
          failureCount: 0,
          nextAttemptAt: null,
          error: null,
          result: null,
          updatedAt: null,
        },
        lxns: {
          enabled: false,
          lastSuccessVersion: null,
          lastAttemptVersion: null,
          status: 'idle',
          failureCount: 0,
          nextAttemptAt: null,
          error: null,
          result: null,
          updatedAt: null,
        },
      },
    });
    const reconcileMap = {
      toDivingFishId: new Map([['17', '17']]),
      toLxnsId: new Map<string, string>(),
      divingFishTitleByDbId: new Map([['17', 'e2e-17']]),
    };
    jest
      .spyOn(moduleA.get(ProberExportMapService), 'getMap')
      .mockResolvedValue(reconcileMap);
    jest
      .spyOn(moduleB.get(ProberExportMapService), 'getMap')
      .mockResolvedValue(reconcileMap);
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as typeof fetch;

    await exportA.reconcile();
    let exportedVersion: number | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const state = await exportStateModel
        .findOne({ friendCode: reconcileFriendCode })
        .lean();
      exportedVersion = state?.providers.divingFish.lastSuccessVersion ?? null;
      if (exportedVersion !== null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(exportedVersion).toBe(0);
    expect(
      await exportJobModel.countDocuments({
        friendCode: reconcileFriendCode,
        kind: 'auto',
      }),
    ).toBe(1);
  });

  it('keeps same-mode creation locked while allowing DXNet and QR creation together', async () => {
    let releaseDxnet: () => void = () => {};
    let markDxnetEntered: () => void = () => {};
    const dxnetEntered = new Promise<void>((resolve) => {
      markDxnetEntered = resolve;
    });
    const holdDxnet = new Promise<void>((resolve) => {
      releaseDxnet = resolve;
    });
    const dxnet = cabinetScores.withCreateLock(
      exportFriendCode,
      'dxnet',
      async () => {
        markDxnetEntered();
        await holdDxnet;
        return 'dxnet';
      },
    );
    await dxnetEntered;

    await expect(
      cabinetScores.withCreateLock(exportFriendCode, 'cabinet', () =>
        Promise.resolve('cabinet'),
      ),
    ).resolves.toBe('cabinet');
    await expect(
      cabinetScores.withCreateLock(exportFriendCode, 'dxnet', () =>
        Promise.resolve('duplicate'),
      ),
    ).rejects.toMatchObject({ status: 409 });

    releaseDxnet();
    await expect(dxnet).resolves.toBe('dxnet');
  });
});
