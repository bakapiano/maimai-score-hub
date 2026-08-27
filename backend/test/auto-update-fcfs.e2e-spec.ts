import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { RedisModule } from '../src/common/redis/redis.module';
import { RedisService } from '../src/common/redis/redis.service';
import { BotStatusService } from '../src/modules/bots/services/bot-status.service';
import { JobService } from '../src/modules/job/services/job.service';
import { ObservabilityIngestService } from '../src/modules/observability/services/observability-ingest.service';
import { ScoreChangeHistoryService } from '../src/modules/sync/services/score-change-history.service';
import {
  AutoUpdateProbeStateEntity,
  AutoUpdateProbeStateSchema,
} from '../src/modules/auto-update/schemas/auto-update-probe-state.schema';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from '../src/modules/auto-update/schemas/auto-update-run.schema';
import {
  AutoUpdateTaskEntity,
  AutoUpdateTaskSchema,
} from '../src/modules/auto-update/schemas/auto-update-task.schema';
import { AutoUpdateFcfsWindowService } from '../src/modules/auto-update/services/auto-update-fcfs-window.service';
import { AutoUpdateDailyFullUpdateService } from '../src/modules/auto-update/services/auto-update-daily-full-update.service';
import { AutoUpdateSchedulerTimingService } from '../src/modules/auto-update/services/auto-update-scheduler-timing.service';

jest.setTimeout(60_000);

const databaseName = `maimai_score_hub_auto_update_e2e_${process.pid}`;
const redisPrefix = `auto-update-e2e:${process.pid}:`;
const testNow = new Date('2026-08-18T18:00:00.000Z');

type CreatedJob = {
  friendCode: string;
  musicIds?: string[];
  context?: Record<string, unknown>;
};

function createJobDouble(created: CreatedJob[]) {
  return {
    getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue(null),
    getActiveFullUpdateScoreByFriendCode: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    findLatestFcfsUpdate: jest.fn().mockResolvedValue(null),
    findLatestDailyFullUpdate: jest.fn().mockResolvedValue(null),
    countActiveUpdateScoreBySource: jest.fn().mockResolvedValue(0),
    create: jest.fn((input: CreatedJob) => {
      created.push(input);
      return Promise.resolve({ jobId: `job-${created.length}` });
    }),
  };
}

async function createModule(created: CreatedJob[]): Promise<TestingModule> {
  const jobs = createJobDouble(created);
  const scoreChanges = {
    changedScoreChartsByFriendBetween: jest.fn().mockResolvedValue([]),
    distinctFriendCodesObservedBetween: jest
      .fn()
      .mockResolvedValue(['daily-a', 'daily-b']),
  };
  const bots = {
    getHealthyBots: jest.fn().mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({
        friendCode: `bot-${index + 1}`,
      })),
    ),
  };

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MongooseModule.forRoot(`mongodb://127.0.0.1:27017/${databaseName}`),
      MongooseModule.forFeature([
        {
          name: AutoUpdateProbeStateEntity.name,
          schema: AutoUpdateProbeStateSchema,
        },
        { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
        { name: AutoUpdateTaskEntity.name, schema: AutoUpdateTaskSchema },
      ]),
      RedisModule,
    ],
    providers: [
      AutoUpdateSchedulerTimingService,
      AutoUpdateFcfsWindowService,
      AutoUpdateDailyFullUpdateService,
      { provide: JobService, useValue: jobs },
      { provide: ScoreChangeHistoryService, useValue: scoreChanges },
      { provide: BotStatusService, useValue: bots },
      {
        provide: ObservabilityIngestService,
        useValue: {
          recordStructuredLogs: jest.fn(),
          recordJobTimelineEvent: jest.fn(),
        },
      },
    ],
  }).compile();
  await module.init();
  return module;
}

describe('auto-update FC/FS producer (local Mongo + Redis e2e)', () => {
  let moduleA: TestingModule;
  let moduleB: TestingModule;
  let stateModel: Model<AutoUpdateProbeStateEntity>;
  let taskModel: Model<AutoUpdateTaskEntity>;
  let runModel: Model<AutoUpdateRunEntity>;
  const createdA: CreatedJob[] = [];
  const createdB: CreatedJob[] = [];

  beforeAll(async () => {
    Object.assign(process.env, {
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_DB: '0',
      REDIS_PASSWORD: '',
      REDIS_KEY_PREFIX: redisPrefix,
      AUTO_UPDATE_TARGETED_FCFS_ENABLED: 'true',
      AUTO_UPDATE_FCFS_RATE_PER_MINUTE: '8',
      AUTO_UPDATE_FCFS_BURST: '2',
      AUTO_UPDATE_FCFS_DRAIN_INTERVAL_MS: '3600000',
      AUTO_UPDATE_FCFS_DRAIN_SCAN_LIMIT: '32',
      AUTO_UPDATE_FCFS_MAX_MUSIC_IDS_PER_JOB: '32',
      AUTO_UPDATE_FCFS_CONTINUATION_DELAY_MS: '300000',
      AUTO_UPDATE_DAILY_FULL_UPDATE_DRAIN_INTERVAL_MS: '3600000',
      AUTO_UPDATE_DAILY_FULL_UPDATE_BATCH_LIMIT: '8',
    });

    moduleA = await createModule(createdA);
    stateModel = moduleA.get(getModelToken(AutoUpdateProbeStateEntity.name));
    taskModel = moduleA.get(getModelToken(AutoUpdateTaskEntity.name));
    runModel = moduleA.get(getModelToken(AutoUpdateRunEntity.name));
    await stateModel.db.dropDatabase();
    await Promise.all([stateModel.init(), taskModel.init(), runModel.init()]);
    moduleB = await createModule(createdB);
  });

  afterAll(async () => {
    await stateModel.db.dropDatabase();
    const redis = moduleA.get(RedisService);
    const keys = await redis.keys(`${redisPrefix}*`);
    await Promise.all(keys.map((key) => redis.del(key)));
    await moduleB.close();
    await moduleA.close();
  });

  beforeEach(async () => {
    createdA.length = 0;
    createdB.length = 0;
    await Promise.all([
      stateModel.deleteMany({}),
      taskModel.deleteMany({}),
      runModel.deleteMany({}),
    ]);
    const redis = moduleA.get(RedisService);
    const keys = await redis.keys(`${redisPrefix}*`);
    await Promise.all(keys.map((key) => redis.del(key)));
  });

  it('shares an 8/minute burst-2 bucket across backend replicas and chunks CID lists', async () => {
    const musicIds = Array.from({ length: 40 }, (_, index) => `${index}_3`);
    await stateModel.insertMany(
      ['friend-a', 'friend-b', 'friend-c'].map((friendCode) => ({
        friendCode,
        cabinetUserId: 100,
        enabled: true,
        tier: 'hot',
        nextFcfsUpdateAt: new Date(testNow.getTime() - 60_000),
        pendingFcfsRequestedAt: new Date(testNow.getTime() - 60_000),
        pendingFcfsMusicIds: musicIds,
      })),
    );

    const serviceA = moduleA.get(AutoUpdateFcfsWindowService);
    const serviceB = moduleB.get(AutoUpdateFcfsWindowService);
    await expect(serviceA.runDrainOnce(testNow)).resolves.toMatchObject({
      healthyBots: 4,
      ratePerMinute: 8,
      due: 3,
      dispatched: 2,
      rateLimited: 1,
    });
    expect(createdA).toHaveLength(2);
    expect(createdA.every((job) => job.musicIds?.length === 32)).toBe(true);
    expect(await taskModel.countDocuments({ status: 'processing' })).toBe(2);

    await expect(serviceB.runDrainOnce(testNow)).resolves.toMatchObject({
      dispatched: 0,
      rateLimited: 1,
    });
    expect(createdB).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 7_600));
    await expect(serviceB.runDrainOnce(testNow)).resolves.toMatchObject({
      dispatched: 1,
      rateLimited: 0,
    });
    expect(createdB).toHaveLength(1);
  });

  it('stages daily full-update tasks through the real timestamped schema', async () => {
    await stateModel.insertMany(
      ['daily-a', 'daily-b'].map((friendCode) => ({
        friendCode,
        cabinetUserId: 200,
        enabled: true,
        tier: 'cold',
      })),
    );
    const daily = moduleA.get(AutoUpdateDailyFullUpdateService);

    await expect(daily.run(testNow)).resolves.toMatchObject({ staged: 2 });
    expect(await taskModel.countDocuments({ type: 'daily_full_update' })).toBe(
      2,
    );
    expect(
      await runModel.countDocuments({
        bucketKey: /^daily-full-update:/,
        status: 'completed',
      }),
    ).toBe(1);
  });

  it('fills an independent eight-job daily waterline in one drain tick', async () => {
    await taskModel.insertMany(
      Array.from({ length: 10 }, (_, index) => ({
        id: `daily-full-update:2026-08-17:daily-${index}`,
        type: 'daily_full_update',
        friendCode: `daily-${index}`,
        cabinetUserId: 10_000 + index,
        status: 'queued',
        runAt: testNow,
        attempts: 0,
        metrics: { businessDate: '2026-08-17' },
      })),
    );
    const daily = moduleA.get(AutoUpdateDailyFullUpdateService);

    const result = await daily.runDrainOnce(testNow);

    expect(result).toMatchObject({
      activeDailyUpdateScores: 0,
      dispatchLimit: 8,
      dispatched: 8,
    });
    expect(
      await taskModel.countDocuments({
        type: 'daily_full_update',
        status: 'processing',
      }),
    ).toBe(8);
    expect(
      await taskModel.countDocuments({
        type: 'daily_full_update',
        status: 'queued',
      }),
    ).toBe(2);
  });
});
