/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
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
    bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const taskModel = {
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
    create: jest.fn().mockResolvedValue({ jobId: 'fcfs-job' }),
  };
  const scoreChanges = {
    changedScoreChartsByFriendBetween: jest
      .fn()
      .mockResolvedValue([
        { friendCode: 'friend-a', musicIds: ['17_3', '18_4'] },
      ]),
  };
  const timing = {
    fcfsEnabled: true,
    mapBatchLimit: 120,
    mapConcurrency: 2,
    fcfsCooldownMs: 30 * 60_000,
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
    incrementWithExpiry: jest.fn().mockResolvedValue(1),
  };
  return {
    service: new AutoUpdateFcfsWindowService(
      stateModel as any,
      taskModel as any,
      runsModel as any,
      jobs as any,
      scoreChanges as any,
      timing as any,
      leases as any,
      redis as any,
    ),
    stateModel,
    taskModel,
    runsModel,
    jobs,
    scoreChanges,
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
    const { service, timing, leases, stateModel } = createHarness();
    timing.fcfsEnabled = false;

    await expect(
      service.run(new Date('2026-08-18T02:47:00.000Z')),
    ).resolves.toMatchObject({
      changedUsers: 0,
      due: 0,
      dispatched: 0,
    });
    expect(leases.run).not.toHaveBeenCalled();
    expect(stateModel.find).not.toHaveBeenCalled();
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
    const { service, jobs, stateModel } = createHarness();
    const now = new Date('2026-08-18T02:47:00.000Z');
    const state = {
      friendCode: 'friend-a',
      cabinetUserId: 42,
      pendingFcfsMusicIds: ['17_3', '18_4', '17_3'],
      pendingFcfsWindowStart: new Date('2026-08-18T02:00:00.000Z'),
      pendingFcfsWindowEnd: new Date('2026-08-18T02:30:00.000Z'),
      fcfsErrorCount: 0,
    };

    await expect((service as any).dispatchState(state, now)).resolves.toBe(
      'dispatched',
    );
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
      expect.objectContaining({
        $set: expect.objectContaining({
          nextFcfsUpdateAt: new Date('2026-08-18T03:17:00.000Z'),
          pendingFcfsMusicIds: [],
        }),
      }),
    );
  });

  it('preserves the old burst limit before consuming minute quota', async () => {
    const { service, redis } = createHarness();
    redis.incrementWithExpiry.mockResolvedValueOnce(7);

    await expect(
      (service as any).acquireProducerSlot(
        new Date('2026-08-18T02:47:00.000Z'),
      ),
    ).resolves.toBe(false);
    expect(redis.incrementWithExpiry).toHaveBeenCalledTimes(1);
  });
});
