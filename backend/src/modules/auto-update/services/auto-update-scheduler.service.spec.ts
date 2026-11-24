/* eslint-disable max-lines-per-function, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { AutoUpdateSchedulerService } from './auto-update-scheduler.service';

function queryResult<T>(value: T) {
  const query: Record<string, jest.Mock> = {};
  query.sort = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

function createService(overrides?: {
  stateModel?: Record<string, unknown>;
  taskModel?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  botStatus?: Record<string, unknown>;
  sdgb?: Record<string, unknown>;
  activity?: Record<string, unknown>;
}) {
  const timing = {
    concurrency: 4,
    rivalBatchLimit: 480,
    sweepHardTimeoutMs: 600_000,
    mapConcurrency: 2,
    mapBatchLimit: 120,
    settledFullUpdateRetryMs: 10 * 60 * 1000,
    settledFullUpdateClaimTimeoutMs: 5 * 60 * 1000,
    priorityForTier: jest.fn(() => 30),
    settledFullUpdateDispatchLimit: jest.fn(() => 0),
  };
  const stateModel = {
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...(overrides?.stateModel ?? {}),
  };
  const taskModel = {
    find: jest.fn(() => queryResult([])),
    create: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...(overrides?.taskModel ?? {}),
  };
  const jobs = {
    countActiveUpdateScoreBySource: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({ jobId: 'recent-job' }),
    getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    findLatestSettledFullUpdate: jest.fn().mockResolvedValue(null),
    ...(overrides?.jobs ?? {}),
  };
  const botStatus = {
    pickAvailableCabinetBot: jest.fn().mockResolvedValue({
      friendCode: 'bot-fc',
      cabinetUserId: 123,
    }),
    ...(overrides?.botStatus ?? {}),
  };
  const sdgb = {
    addRival: jest.fn().mockResolvedValue({ returnCode1: 2, returnCode2: 2 }),
    ...(overrides?.sdgb ?? {}),
  };
  const activity = {
    recordActivitySignal: jest.fn().mockResolvedValue(undefined),
    ...(overrides?.activity ?? {}),
  };
  const fcfsWindow = {
    run: jest.fn().mockResolvedValue({
      windowKey: '2026-07-05T06:00',
      changedUsers: 0,
      reconciled: 0,
      due: 0,
      dispatched: 0,
      deferred: 0,
      failed: 0,
    }),
  };
  const dailyFullUpdate = {
    run: jest.fn().mockResolvedValue({
      businessDate: null,
      staged: 0,
      reconciled: 0,
      dispatched: 0,
      activeDailyUpdateScores: 0,
      dispatchLimit: 0,
    }),
  };

  const runsModel = {
    findOneAndUpdate: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  return {
    service: new AutoUpdateSchedulerService(
      {} as any,
      jobs as any,
      botStatus as any,
      sdgb as any,
      {} as any,
      {} as any,
      stateModel as any,
      taskModel as any,
      runsModel as any,
      timing as any,
      activity as any,
      fcfsWindow as any,
      dailyFullUpdate as any,
      {} as any,
    ),
    timing,
    stateModel,
    taskModel,
    jobs,
    botStatus,
    sdgb,
    activity,
    fcfsWindow,
    dailyFullUpdate,
    runsModel,
  };
}

describe('AutoUpdateSchedulerService probe fairness', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reaches Map and settlement with a full slow Rival backlog', async () => {
    const rivalStates = Array.from({ length: 480 }, (_, i) => ({
      friendCode: `r${i}`,
    }));
    const mapStates = Array.from({ length: 120 }, (_, i) => ({
      friendCode: `m${i}`,
    }));
    const find = jest
      .fn()
      .mockImplementationOnce(() => queryResult(rivalStates))
      .mockImplementationOnce(() => queryResult(mapStates));
    const { service, stateModel, fcfsWindow, dailyFullUpdate } = createService({
      stateModel: { find },
    });
    const internal = service as any;
    jest.spyOn(internal, 'syncEnabledStates').mockResolvedValue(undefined);
    const rival = jest
      .spyOn(internal, 'processRivalProbe')
      .mockImplementation(async (state: any) => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { friendCode: state.friendCode, action: 'skipped' };
      });
    const map = jest
      .spyOn(internal, 'processMapProbe')
      .mockImplementation(async (state: any) => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { friendCode: state.friendCode, action: 'skipped' };
      });
    const sweep = service.runSweep();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(map).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_001);
    const summary = await sweep;
    expect(rival).toHaveBeenCalledTimes(24);
    expect(map).toHaveBeenCalledTimes(12);
    expect(summary.totalUsers).toBe(36);
    expect(summary.skippedNoChange).toBe(36);
    expect(summary.entries).toHaveLength(36);
    expect(fcfsWindow.run).toHaveBeenCalledTimes(1);
    expect(dailyFullUpdate.run).toHaveBeenCalledTimes(1);
    // Admission does not advance dates or create tasks for deferred users.
    expect(stateModel.updateOne).not.toHaveBeenCalled();
  });

  it('finishes admitted long-running Rival calls before entering Map', async () => {
    const states = Array.from({ length: 10 }, (_, i) => ({
      friendCode: `r${i}`,
    }));
    const find = jest
      .fn()
      .mockImplementationOnce(() => queryResult(states))
      .mockImplementationOnce(() => queryResult([{ friendCode: 'map' }]));
    const { service } = createService({ stateModel: { find } });
    const internal = service as any;
    jest.spyOn(internal, 'syncEnabledStates').mockResolvedValue(undefined);
    const rival = jest
      .spyOn(internal, 'processRivalProbe')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120_000));
        return { action: 'failed' };
      });
    const map = jest
      .spyOn(internal, 'processMapProbe')
      .mockResolvedValue({ action: 'skipped' });
    const sweep = service.runSweep();
    await jest.advanceTimersByTimeAsync(119_999);
    expect(map).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(sweep).resolves.toMatchObject({ totalUsers: 5, failed: 4 });
    expect(rival).toHaveBeenCalledTimes(4);
    expect(map).toHaveBeenCalledTimes(1);
  });

  it('finalizes failed run rows rather than leaving them running forever', async () => {
    const { service, runsModel } = createService();
    const error = new Error('lease hard timeout');
    jest.spyOn(service, 'runSweep').mockRejectedValue(error);
    await expect((service as any).runSweepClaimed()).rejects.toBe(error);
    expect(runsModel.updateOne).toHaveBeenCalledWith(expect.any(Object), {
      $set: {
        status: 'failed',
        finishedAt: expect.any(Date),
        lastError: error.message,
      },
    });
  });
});

describe('AutoUpdateSchedulerService settled full updates', () => {
  it('creates a full update_score job for due pending settled updates', async () => {
    const { service, stateModel, jobs } = createService();
    const now = new Date('2026-07-05T07:00:00.000Z');
    const state = {
      friendCode: '634142510810999',
      cabinetUserId: 42,
      lastAutoUpdateActivityAt: new Date('2026-07-05T06:15:00.000Z'),
      pendingFullUpdateAt: new Date('2026-07-05T07:00:00.000Z'),
    };

    const result = await (service as any).processPendingFullUpdate(state, now);

    expect(result).toBe('created');
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        friendCode: '634142510810999',
        jobType: 'update_score',
        source: 'auto_update',
        diffsToScrape: [0, 1, 2, 3, 4, 10],
        fcfsOnly: true,
        cancelActiveJobs: false,
        context: expect.objectContaining({
          source: 'auto_update_settled_full_update',
          lastActivityAt: '2026-07-05T06:15:00.000Z',
        }),
      }),
    );
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      {
        friendCode: '634142510810999',
        pendingFullUpdateAt: new Date('2026-07-05T07:00:00.000Z'),
      },
      {
        $set: {
          pendingFullUpdateAt: null,
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
  });

  it('tracks an active full update until it completes', async () => {
    const { service, stateModel, jobs } = createService({
      jobs: {
        getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue({
          id: 'active-job',
          jobType: 'update_score',
          musicIds: null,
        }),
      },
    });
    const now = new Date('2026-07-05T07:00:00.000Z');

    const result = await (service as any).processPendingFullUpdate(
      {
        friendCode: '634142510810999',
        cabinetUserId: 42,
        pendingFullUpdateAt: new Date('2026-07-05T07:00:00.000Z'),
      },
      now,
    );

    expect(result).toBe('coveredByActive');
    expect(jobs.create).not.toHaveBeenCalled();
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      {
        friendCode: '634142510810999',
        pendingFullUpdateAt: new Date('2026-07-05T07:00:00.000Z'),
      },
      {
        $set: {
          pendingFullUpdateAt: null,
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
  });

  it('keeps settled work pending while a targeted update is active', async () => {
    const { service, stateModel, jobs, taskModel } = createService({
      jobs: {
        getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue({
          id: 'targeted-job',
          jobType: 'update_score',
          musicIds: ['17_3'],
        }),
      },
    });

    await expect(
      (service as any).processPendingFullUpdate(
        {
          friendCode: '634142510810999',
          cabinetUserId: 42,
          pendingFullUpdateAt: new Date('2026-07-05T07:00:00.000Z'),
        },
        new Date('2026-07-05T07:00:00.000Z'),
      ),
    ).resolves.toBe('deferred');
    expect(jobs.create).not.toHaveBeenCalled();
    expect(taskModel.create).not.toHaveBeenCalled();
    expect(stateModel.updateOne).not.toHaveBeenCalled();
  });

  it('keeps settled work pending while a partial-difficulty update is active', async () => {
    const { service, jobs, taskModel } = createService({
      jobs: {
        getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue({
          id: 'partial-diff-job',
          jobType: 'update_score',
          musicIds: null,
          diffsToScrape: [2, 3, 4, 10],
        }),
      },
    });

    await expect(
      (service as any).processPendingFullUpdate(
        {
          friendCode: '634142510810999',
          cabinetUserId: 42,
          pendingFullUpdateAt: new Date('2026-07-05T07:00:00.000Z'),
        },
        new Date('2026-07-05T07:00:00.000Z'),
      ),
    ).resolves.toBe('deferred');
    expect(jobs.create).not.toHaveBeenCalled();
    expect(taskModel.create).not.toHaveBeenCalled();
  });

  it('restores settled pending state when the tracked full job fails', async () => {
    const now = new Date('2026-07-05T07:20:00.000Z');
    const task = {
      id: 'settled-task',
      type: 'settled_full_update',
      friendCode: '634142510810999',
      status: 'processing',
      createdAt: new Date('2026-07-05T07:00:00.000Z'),
      updatedAt: new Date('2026-07-05T07:00:00.000Z'),
      metrics: { jobId: 'full-job' },
    };
    const taskModel = {
      find: jest.fn(() => queryResult([task])),
      create: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const { service, stateModel, jobs } = createService({
      taskModel,
      jobs: {
        findById: jest.fn().mockResolvedValue({
          id: 'full-job',
          status: 'failed',
          error: 'job aborted',
        }),
      },
    });

    await expect(
      (service as any).reconcileSettledFullUpdateTasks(now),
    ).resolves.toBe(1);
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ friendCode: '634142510810999' }),
      {
        $set: {
          pendingFullUpdateAt: new Date('2026-07-05T07:30:00.000Z'),
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
    expect(taskModel.updateOne).toHaveBeenCalledWith(
      { id: 'settled-task', status: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          lastError: 'job aborted',
        }),
      }),
    );
    expect(jobs.findById).toHaveBeenCalledWith('full-job');
  });
});
