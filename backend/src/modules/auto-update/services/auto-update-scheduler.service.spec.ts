/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { AutoUpdateSchedulerService } from './auto-update-scheduler.service';

function createService(overrides?: {
  stateModel?: Record<string, unknown>;
  taskModel?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  botStatus?: Record<string, unknown>;
  sdgb?: Record<string, unknown>;
  activity?: Record<string, unknown>;
}) {
  const timing = {
    mapConcurrency: 2,
    mapBatchLimit: 120,
    settledFullUpdateRetryMs: 10 * 60 * 1000,
    priorityForTier: jest.fn(() => 30),
  };
  const stateModel = {
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...(overrides?.stateModel ?? {}),
  };
  const taskModel = {
    create: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...(overrides?.taskModel ?? {}),
  };
  const jobs = {
    create: jest.fn().mockResolvedValue({ jobId: 'recent-job' }),
    getActiveUpdateScoreByFriendCode: jest.fn().mockResolvedValue(null),
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
      activeUpdateScores: 0,
      dispatchLimit: 0,
    }),
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
      {} as any,
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
  };
}

describe('AutoUpdateSchedulerService settled full updates', () => {
  it('creates a full update_score job for due pending settled updates', async () => {
    const { service, stateModel, jobs } = createService();
    const now = new Date('2026-07-05T07:00:00.000Z');
    const state = {
      friendCode: '634142510810999',
      lastAutoUpdateActivityAt: new Date('2026-07-05T06:15:00.000Z'),
    };

    const result = await (service as any).processPendingFullUpdate(state, now);

    expect(result).toBe('created');
    expect(jobs.create).toHaveBeenCalledWith({
      friendCode: '634142510810999',
      jobType: 'update_score',
      diffsToScrape: null,
      cancelActiveJobs: false,
      context: {
        source: 'auto_update_settled_full_update',
        lastActivityAt: '2026-07-05T06:15:00.000Z',
      },
    });
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: '634142510810999' },
      {
        $set: {
          pendingFullUpdateAt: null,
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
  });

  it('clears pending settled updates when an update_score job is already active', async () => {
    const { service, stateModel, jobs } = createService({
      jobs: {
        getActiveUpdateScoreByFriendCode: jest
          .fn()
          .mockResolvedValue({ id: 'active-job', jobType: 'update_score' }),
      },
    });
    const now = new Date('2026-07-05T07:00:00.000Z');

    const result = await (service as any).processPendingFullUpdate(
      { friendCode: '634142510810999' },
      now,
    );

    expect(result).toBe('coveredByActive');
    expect(jobs.create).not.toHaveBeenCalled();
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: '634142510810999' },
      {
        $set: {
          pendingFullUpdateAt: null,
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
  });
});
