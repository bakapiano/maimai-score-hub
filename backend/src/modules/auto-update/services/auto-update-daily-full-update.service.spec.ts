/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
import {
  AutoUpdateDailyFullUpdateService,
  dailyFullUpdateWindow,
} from './auto-update-daily-full-update.service';

function queryResult<T>(value: T) {
  const query: Record<string, jest.Mock> = {};
  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

function createHarness(input?: {
  processingTasks?: Record<string, unknown>[];
  queuedTasks?: Record<string, unknown>[];
  eligibleStates?: Record<string, unknown>[];
  dailyRun?: Record<string, unknown> | null;
  activeCount?: number;
  leaseAcquired?: boolean;
}) {
  const processingQuery = queryResult(input?.processingTasks ?? []);
  const queuedQuery = queryResult(input?.queuedTasks ?? []);
  const stateQuery = queryResult(input?.eligibleStates ?? []);
  const runQuery = queryResult(input?.dailyRun ?? null);
  const claimed = new Map(
    (input?.queuedTasks ?? []).map((task) => [String(task.id), task]),
  );
  const stateModel = { find: jest.fn(() => stateQuery) };
  const taskModel = {
    bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 0 }),
    find: jest
      .fn()
      .mockReturnValueOnce(processingQuery)
      .mockReturnValueOnce(queuedQuery),
    findOneAndUpdate: jest.fn((filter: { id: string }) =>
      queryResult(claimed.get(filter.id) ?? null),
    ),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const runsModel = {
    findOne: jest.fn(() => runQuery),
    create: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const jobs = {
    countActiveUpdateScores: jest
      .fn()
      .mockResolvedValue(input?.activeCount ?? 0),
    findById: jest.fn().mockResolvedValue(null),
    findLatestDailyFullUpdate: jest.fn().mockResolvedValue(null),
    getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue(null),
    create: jest
      .fn()
      .mockImplementation(({ friendCode }: { friendCode: string }) =>
        Promise.resolve({ jobId: `job-${friendCode}` }),
      ),
  };
  const scoreChanges = {
    distinctFriendCodesObservedBetween: jest
      .fn()
      .mockResolvedValue(['friend-a', 'friend-b']),
  };
  const timing = {
    dailyFullUpdateHour: 2,
    dailyFullUpdateBatchLimit: 4,
    dailyFullUpdateMaxActive: 8,
    dailyFullUpdateRetryMs: 10 * 60_000,
    dailyFullUpdateMaxAttempts: 3,
    dailyFullUpdateClaimTimeoutMs: 5 * 60_000,
    leaseTtlMs: 90_000,
    leaseRenewEveryMs: 30_000,
    sweepHardTimeoutMs: 10 * 60_000,
    sweepAbortGraceMs: 3 * 60_000,
    dailyFullUpdateDispatchLimit: jest.fn((active: number) =>
      Math.min(4, Math.max(0, 8 - active)),
    ),
  };
  const leases = {
    run: jest.fn(
      async (
        _options: unknown,
        task: (context: { signal: AbortSignal }) => Promise<number>,
      ) => {
        if (input?.leaseAcquired === false) {
          return { acquired: false };
        }
        return {
          acquired: true,
          value: await task({ signal: new AbortController().signal }),
        };
      },
    ),
  };
  const service = new AutoUpdateDailyFullUpdateService(
    stateModel as any,
    taskModel as any,
    runsModel as any,
    jobs as any,
    scoreChanges as any,
    timing as any,
    leases as any,
  );
  return {
    service,
    stateModel,
    stateQuery,
    taskModel,
    queuedQuery,
    runsModel,
    jobs,
    scoreChanges,
    timing,
    leases,
  };
}

describe('dailyFullUpdateWindow', () => {
  it('opens at 02:00 China time for the previous UTC+8 calendar day', () => {
    expect(
      dailyFullUpdateWindow(new Date('2026-08-17T17:59:59.000Z'), 2),
    ).toBeNull();
    expect(
      dailyFullUpdateWindow(new Date('2026-08-17T18:00:00.000Z'), 2),
    ).toEqual({
      businessDate: '2026-08-17',
      start: new Date('2026-08-16T16:00:00.000Z'),
      end: new Date('2026-08-17T16:00:00.000Z'),
    });
  });
});

describe('AutoUpdateDailyFullUpdateService staging', () => {
  it('stages one deterministic task per eligible changed user', async () => {
    const { service, taskModel, runsModel, scoreChanges } = createHarness({
      eligibleStates: [
        { friendCode: 'friend-a', cabinetUserId: 101 },
        { friendCode: 'friend-b', cabinetUserId: 102 },
      ],
    });

    const result = await service.run(new Date('2026-08-17T18:00:00.000Z'));

    expect(result.businessDate).toBe('2026-08-17');
    expect(result.staged).toBe(2);
    expect(
      scoreChanges.distinctFriendCodesObservedBetween,
    ).toHaveBeenCalledWith(
      new Date('2026-08-16T16:00:00.000Z'),
      new Date('2026-08-17T16:00:00.000Z'),
    );
    expect(taskModel.bulkWrite).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { id: 'daily-full-update:2026-08-17:friend-a' },
            upsert: true,
          }),
        }),
      ]),
      { ordered: false },
    );
    expect(runsModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketKey: 'daily-full-update:2026-08-17',
        status: 'running',
      }),
    );
    expect(runsModel.updateOne).toHaveBeenCalledWith(
      { bucketKey: 'daily-full-update:2026-08-17' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'completed', totalUsers: 2 }),
      }),
    );
  });

  it('lets the daily lease owner alone stage the business date', async () => {
    const { service, runsModel, scoreChanges } = createHarness({
      leaseAcquired: false,
    });

    const result = await service.run(new Date('2026-08-17T18:00:00.000Z'));

    expect(result.staged).toBe(0);
    expect(runsModel.findOne).not.toHaveBeenCalled();
    expect(
      scoreChanges.distinctFriendCodesObservedBetween,
    ).not.toHaveBeenCalled();
  });

  it('uses the completed daily run marker as the once-per-day fence', async () => {
    const { service, scoreChanges, taskModel } = createHarness({
      dailyRun: { status: 'completed' },
    });

    await service.run(new Date('2026-08-17T18:05:00.000Z'));

    expect(
      scoreChanges.distinctFriendCodesObservedBetween,
    ).not.toHaveBeenCalled();
    expect(taskModel.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('AutoUpdateDailyFullUpdateService dispatch', () => {
  it('dispatches only the free portion of the global update-score waterline', async () => {
    const tasks = [
      {
        id: 'daily-full-update:2026-08-16:friend-a',
        type: 'daily_full_update',
        friendCode: 'friend-a',
        status: 'queued',
        attempts: 1,
        metrics: { businessDate: '2026-08-16' },
      },
      {
        id: 'daily-full-update:2026-08-16:friend-b',
        type: 'daily_full_update',
        friendCode: 'friend-b',
        status: 'queued',
        attempts: 1,
        metrics: { businessDate: '2026-08-16' },
      },
    ];
    const { service, queuedQuery, jobs } = createHarness({
      queuedTasks: tasks,
      activeCount: 6,
    });

    const result = await service.run(new Date('2026-08-17T17:00:00.000Z'));

    expect(result.dispatchLimit).toBe(2);
    expect(result.dispatched).toBe(2);
    expect(queuedQuery.limit).toHaveBeenCalledWith(2);
    expect(jobs.create).toHaveBeenCalledTimes(2);
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        friendCode: 'friend-a',
        source: 'auto_update',
        context: expect.objectContaining({
          source: 'auto_update_daily_full_update',
          dailyTaskId: tasks[0].id,
        }),
      }),
    );
  });

  it('requeues a failed tracked job with bounded retry delay', async () => {
    const task = {
      id: 'daily-full-update:2026-08-16:friend-a',
      type: 'daily_full_update',
      friendCode: 'friend-a',
      status: 'processing',
      attempts: 1,
      updatedAt: new Date('2026-08-17T16:00:00.000Z'),
      metrics: { jobId: 'job-a' },
    };
    const { service, jobs, taskModel } = createHarness({
      processingTasks: [task],
      activeCount: 8,
    });
    jobs.findById.mockResolvedValue({
      id: 'job-a',
      status: 'failed',
      error: 'worker failed',
    });

    await service.run(new Date('2026-08-17T17:00:00.000Z'));

    expect(taskModel.updateOne).toHaveBeenCalledWith(
      { id: task.id, status: 'processing' },
      {
        $set: expect.objectContaining({
          status: 'queued',
          runAt: new Date('2026-08-17T17:10:00.000Z'),
          lastError: 'worker failed',
        }),
      },
    );
  });
});
