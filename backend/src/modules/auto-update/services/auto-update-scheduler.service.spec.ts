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
    recentEventCooldownMs: 30 * 60 * 1000,
    recentEventDelayMs: 3 * 60 * 1000,
    settledFullUpdateRetryMs: 10 * 60 * 1000,
    recentEventRetryDelayMs: jest.fn((count: number) => count * 30 * 60 * 1000),
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
      {} as any,
    ),
    timing,
    stateModel,
    taskModel,
    jobs,
    botStatus,
    sdgb,
    activity,
  };
}

describe('AutoUpdateSchedulerService FC/FS production stopgap', () => {
  it('does not enqueue FC/FS enrichment while the path is disabled', async () => {
    const { service, stateModel, taskModel, jobs } = createService();
    const now = new Date('2026-07-05T06:00:00.000Z');
    const state = {
      friendCode: '634142510810999',
      cabinetUserId: 456,
      nextRecentEventAt: new Date('2026-07-05T06:20:00.000Z'),
      pendingRecentEventReason: null,
      pendingRecentEventRequestedAt: null,
      pendingRecentEventCount: 0,
    };

    await (service as any).maybeEnqueueFcfs(state, 'map_delta', now);

    expect(taskModel.create).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
    expect(stateModel.updateOne).not.toHaveBeenCalled();
  });

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
      priority: 1,
      diffsToScrape: null,
      cancelActiveJobs: false,
      removeFriendAfterComplete: true,
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
