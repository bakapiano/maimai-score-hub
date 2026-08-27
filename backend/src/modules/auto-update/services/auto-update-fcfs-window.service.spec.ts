/* eslint-disable max-lines-per-function, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  AutoUpdateFcfsWindowService,
  latestClosedFcfsWindow,
} from './auto-update-fcfs-window.service';

function queryResult<T>(value: T) {
  const query: Record<string, jest.Mock> = {};
  query.sort = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

function createHarness() {
  const stateModel = {
    find: jest.fn(() => queryResult([])),
    aggregate: jest.fn(() => ({
      exec: jest.fn().mockResolvedValue([
        {
          pendingUsers: 12,
          dueUsers: 8,
          pendingCidCount: 40,
          oldestDueAgeMs: 120_000,
          dueAgePercentilesMs: [30_000, 90_000],
        },
      ]),
    })),
    bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const taskModel = {
    find: jest.fn(() => queryResult([])),
    create: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const runsModel = {
    findOne: jest.fn(() => queryResult(null)),
    create: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const jobs = {
    getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    findLatestFcfsUpdate: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ jobId: 'fcfs-job' }),
  };
  const scoreChanges = {
    changedScoreChartsByFriendBetween: jest
      .fn()
      .mockResolvedValue([
        { friendCode: 'friend-a', musicIds: ['17_3', '18_4'] },
      ]),
  };
  const botStatus = {
    getHealthyBots: jest
      .fn()
      .mockResolvedValue([
        { friendCode: 'bot-a' },
        { friendCode: 'bot-b' },
        { friendCode: 'bot-c' },
        { friendCode: 'bot-d' },
      ]),
  };
  const observability = {
    recordStructuredLogs: jest.fn(),
    recordJobTimelineEvent: jest.fn(),
  };
  const timing = {
    fcfsEnabled: true,
    fcfsCooldownMs: 30 * 60_000,
    fcfsClaimTimeoutMs: 5 * 60_000,
    fcfsRatePerMinute: 8,
    fcfsBurst: 2,
    fcfsDrainIntervalMs: 5_000,
    fcfsDrainScanLimit: 32,
    fcfsMaxMusicIdsPerJob: 32,
    fcfsContinuationDelayMs: 5 * 60_000,
    fcfsRateForHealthyBots: jest.fn(() => 8),
    fcfsRetryDelayMs: jest.fn((count: number) => count * 30 * 60_000),
    leaseTtlMs: 90_000,
    leaseRenewEveryMs: 30_000,
    sweepHardTimeoutMs: 10 * 60_000,
    sweepAbortGraceMs: 3 * 60_000,
  };
  const leases = {
    run: jest.fn(async (_options: unknown, task: (ctx: any) => any) => ({
      acquired: true,
      value: await task({ signal: new AbortController().signal }),
    })),
  };
  const redis = {
    key: jest.fn((key: string) => key),
    setNx: jest.fn().mockResolvedValue(false),
    tryAcquireLeakyBucket: jest
      .fn()
      .mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
  };
  return {
    service: new AutoUpdateFcfsWindowService(
      stateModel as any,
      taskModel as any,
      runsModel as any,
      jobs as any,
      scoreChanges as any,
      botStatus as any,
      observability as any,
      timing as any,
      leases as any,
      redis as any,
    ),
    stateModel,
    taskModel,
    runsModel,
    jobs,
    scoreChanges,
    botStatus,
    observability,
    timing,
    leases,
    redis,
  };
}

describe('latestClosedFcfsWindow', () => {
  it('uses stable half-hour boundaries', () => {
    expect(
      latestClosedFcfsWindow(new Date('2026-08-18T02:47:00.000Z')),
    ).toEqual({
      start: new Date('2026-08-18T02:00:00.000Z'),
      end: new Date('2026-08-18T02:30:00.000Z'),
      key: '2026-08-18T02:30',
    });
  });
});

describe('AutoUpdateFcfsWindowService', () => {
  it('keeps the producer dormant behind the rollout gate', async () => {
    const { service, timing, leases, stateModel, taskModel } = createHarness();
    timing.fcfsEnabled = false;

    await expect(
      service.run(new Date('2026-08-18T02:47:00.000Z')),
    ).resolves.toMatchObject({
      changedUsers: 0,
    });
    expect(leases.run).not.toHaveBeenCalled();
    expect(stateModel.find).not.toHaveBeenCalled();
    expect(taskModel.find).not.toHaveBeenCalled();
  });

  it('stages exact-chart ids from score and DX score changes', async () => {
    const { service, stateModel, runsModel } = createHarness();
    const window = latestClosedFcfsWindow(new Date('2026-08-18T02:47:00.000Z'));

    const count = await (service as any).stageWindow(
      window,
      new Date('2026-08-18T02:47:00.000Z'),
    );

    expect(count).toBe(1);
    expect(stateModel.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { friendCode: 'friend-a', enabled: true },
            update: expect.objectContaining({
              $addToSet: {
                pendingFcfsMusicIds: { $each: ['17_3', '18_4'] },
              },
            }),
          }),
        }),
      ],
      { ordered: false },
    );
    expect(runsModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketKey: 'fcfs-score-window:2026-08-18T02:30',
      }),
    );
  });

  it('uses the unique half-hour run marker as the multi-instance fence', async () => {
    const { service, runsModel, scoreChanges, stateModel } = createHarness();
    runsModel.findOne.mockReturnValue(
      queryResult({ status: 'completed' }) as never,
    );
    const window = latestClosedFcfsWindow(new Date('2026-08-18T02:47:00.000Z'));

    await expect(
      (service as any).stageWindow(
        window,
        new Date('2026-08-18T02:47:00.000Z'),
      ),
    ).resolves.toBe(0);
    expect(
      scoreChanges.changedScoreChartsByFriendBetween,
    ).not.toHaveBeenCalled();
    expect(stateModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('dispatches a background targeted fcfsOnly update_score', async () => {
    const { service, jobs, stateModel, observability } = createHarness();
    const now = new Date('2026-08-18T02:47:00.000Z');
    const state = {
      friendCode: 'friend-a',
      cabinetUserId: 42,
      pendingFcfsMusicIds: ['17_3', '18_4', '17_3'],
      pendingFcfsWindowStart: new Date('2026-08-18T02:00:00.000Z'),
      pendingFcfsWindowEnd: new Date('2026-08-18T02:30:00.000Z'),
      fcfsErrorCount: 0,
    };

    await expect(
      (service as any).dispatchState(state, now, 8, 4),
    ).resolves.toBe('dispatched');
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        friendCode: 'friend-a',
        jobType: 'update_score',
        source: 'auto_update',
        musicIds: ['17_3', '18_4'],
        fcfsOnly: true,
        context: expect.objectContaining({
          source: 'auto_update_fcfs_score_window',
          autoUpdateFcfs: true,
        }),
      }),
    );
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: 'friend-a' },
      {
        $pullAll: { pendingFcfsMusicIds: ['17_3', '18_4'] },
        $set: {
          nextFcfsUpdateAt: new Date('2026-08-18T03:17:00.000Z'),
        },
      },
    );
    expect(stateModel.updateOne).not.toHaveBeenCalledWith(
      { friendCode: 'friend-a' },
      expect.objectContaining({
        $set: expect.objectContaining({ lastFcfsUpdateAt: now }),
      }),
    );
    expect(observability.recordJobTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'fcfs-job',
        eventName: 'auto_update_fcfs_dispatched',
        attrs: expect.objectContaining({
          cidCount: 2,
          remainingCidCount: 0,
          effectiveRatePerMinute: 8,
          healthyBots: 4,
        }),
      }),
    );
  });

  it('limits each job to 32 music ids and schedules the next chunk soon', async () => {
    const { service, jobs, stateModel } = createHarness();
    const now = new Date('2026-08-18T02:47:00.000Z');
    const pendingFcfsMusicIds = Array.from(
      { length: 40 },
      (_, index) => `${index}_3`,
    );
    const state = {
      friendCode: 'friend-a',
      cabinetUserId: 42,
      pendingFcfsMusicIds,
      fcfsErrorCount: 0,
    };

    await expect(
      (service as any).dispatchState(state, now, 8, 4),
    ).resolves.toBe('dispatched');
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        musicIds: pendingFcfsMusicIds.slice(0, 32),
      }),
    );
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: 'friend-a' },
      expect.objectContaining({
        $pullAll: { pendingFcfsMusicIds: pendingFcfsMusicIds.slice(0, 32) },
        $set: {
          nextFcfsUpdateAt: new Date('2026-08-18T02:52:00.000Z'),
        },
      }),
    );
  });

  it('marks the task completed only after its DXNet job completes', async () => {
    const { service, taskModel, jobs, stateModel, observability } =
      createHarness();
    const now = new Date('2026-08-18T03:20:00.000Z');
    const task = {
      id: 'fcfs-task',
      type: 'fcfs_enrichment',
      friendCode: 'friend-a',
      status: 'processing',
      createdAt: new Date('2026-08-18T03:00:00.000Z'),
      updatedAt: new Date('2026-08-18T03:00:00.000Z'),
      metrics: { musicIds: ['17_3'], dxnetJobId: 'fcfs-job' },
    };
    taskModel.find.mockReturnValue(queryResult([task]) as never);
    jobs.findById.mockResolvedValue({
      id: 'fcfs-job',
      status: 'completed',
    });

    await expect((service as any).reconcileProcessingTasks(now)).resolves.toBe(
      1,
    );
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: 'friend-a' },
      expect.objectContaining({
        $set: expect.objectContaining({
          lastFcfsUpdateAt: now,
          fcfsErrorCount: 0,
        }),
      }),
    );
    expect(taskModel.updateOne).toHaveBeenCalledWith(
      { id: 'fcfs-task', status: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(observability.recordJobTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'fcfs-job',
        eventName: 'auto_update_fcfs_completed',
        attrs: expect.objectContaining({ cidCount: 1 }),
      }),
    );
  });

  it('puts music ids back into pending when the DXNet job fails', async () => {
    const { service, taskModel, jobs, stateModel } = createHarness();
    const now = new Date('2026-08-18T03:20:00.000Z');
    const task = {
      id: 'fcfs-task',
      type: 'fcfs_enrichment',
      friendCode: 'friend-a',
      status: 'processing',
      createdAt: new Date('2026-08-18T03:00:00.000Z'),
      updatedAt: new Date('2026-08-18T03:00:00.000Z'),
      metrics: {
        musicIds: ['17_3', '18_4'],
        dxnetJobId: 'fcfs-job',
        failureCount: 0,
      },
    };
    taskModel.find.mockReturnValue(queryResult([task]) as never);
    jobs.findById.mockResolvedValue({
      id: 'fcfs-job',
      status: 'failed',
      error: 'job aborted',
    });

    await expect((service as any).reconcileProcessingTasks(now)).resolves.toBe(
      1,
    );
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: 'friend-a' },
      expect.objectContaining({
        $addToSet: {
          pendingFcfsMusicIds: { $each: ['17_3', '18_4'] },
        },
        $set: expect.objectContaining({
          fcfsErrorCount: 1,
          nextFcfsUpdateAt: new Date('2026-08-18T03:50:00.000Z'),
        }),
      }),
    );
    expect(taskModel.updateOne).toHaveBeenCalledWith(
      { id: 'fcfs-task', status: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          lastError: 'job aborted',
        }),
      }),
    );
  });

  it('uses the shared leaky bucket for producer pacing', async () => {
    const { service, redis } = createHarness();
    redis.tryAcquireLeakyBucket.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 7_500,
    });

    await expect((service as any).acquireProducerSlot(8)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 7_500,
    });
    expect(redis.tryAcquireLeakyBucket).toHaveBeenCalledWith(
      'dxnet:auto-fcfs:leaky-bucket',
      7_500,
      2,
    );
  });

  it('records the minute backlog snapshot through ClickHouse observability', async () => {
    const { service, redis, observability } = createHarness();
    redis.setNx.mockResolvedValueOnce(true);
    const now = new Date('2026-08-18T02:47:00.000Z');

    await (service as any).recordBacklogSnapshotOnce(now, {
      healthyBots: 4,
      ratePerMinute: 8,
      reconciled: 1,
      due: 12,
      dispatched: 1,
      deferred: 2,
      rateLimited: 1,
      failed: 0,
    });

    expect(observability.recordStructuredLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'backend',
        entries: [
          expect.objectContaining({
            eventName: 'auto_update_fcfs_backlog_snapshot',
            attrs: expect.objectContaining({
              pendingUsers: 12,
              dueUsers: 8,
              pendingCidCount: 40,
              p95DueAgeMs: 90_000,
              healthyBots: 4,
              effectiveRatePerMinute: 8,
            }),
          }),
        ],
      }),
    );
  });
});
