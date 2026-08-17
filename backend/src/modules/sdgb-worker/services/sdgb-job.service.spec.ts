import { Queue, QueueEvents } from 'bullmq';
import {
  SDGB_INTERACTIVE_QUEUE_NAME,
  SDGB_PROBE_QUEUE_NAME,
} from '@maimai-score-hub/shared';

import { SdgbJobService } from './sdgb-job.service';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(undefined),
  })),
  QueueEvents: jest.fn().mockImplementation((name: string) => ({
    name,
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('SdgbJobService lane enqueueing', () => {
  const model = {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue(undefined),
  };
  const observability = {
    recordJobTimelineEvent: jest.fn(),
  };
  const registry = {
    listWorkers: jest.fn().mockResolvedValue([]),
  };
  const adminQueries = {
    getStatus: jest.fn(),
    list: jest.fn(),
  };
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    model.create.mockImplementation((input: Record<string, unknown>) => {
      const values = {
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return Promise.resolve({
        ...values,
        toObject: () => values,
      });
    });
  });

  it.each([
    ['get_rival_hash', SDGB_PROBE_QUEUE_NAME, 10],
    ['get_user_map', SDGB_PROBE_QUEUE_NAME, 10],
    ['scan_qr', SDGB_INTERACTIVE_QUEUE_NAME, 1],
    ['get_music_score', SDGB_INTERACTIVE_QUEUE_NAME, 1],
    ['add_rival', SDGB_INTERACTIVE_QUEUE_NAME, 4],
  ] as const)(
    'enqueues %s on %s with priority %s',
    async (jobType, queueName, priority) => {
      const service = new SdgbJobService(
        model as never,
        observability as never,
        registry as never,
        adminQueries as never,
        config as never,
      );
      const queues = (Queue as unknown as jest.Mock).mock.results.map(
        (result) =>
          (
            result as unknown as {
              value: { name: string; add: jest.Mock };
            }
          ).value,
      );
      const queue = queues.find((candidate) => candidate.name === queueName);

      await service.enqueue({ jobType, payload: {} });

      expect(queue?.add).toHaveBeenCalledTimes(1);
      const call = queue?.add.mock.calls[0] as unknown as [
        string,
        { jobId: string; attempt: number },
        { jobId: string; priority: number },
      ];
      expect(call[0]).toBe(
        queueName === SDGB_PROBE_QUEUE_NAME
          ? 'sdgb-probe-job'
          : 'sdgb-interactive-job',
      );
      expect(call[1].attempt).toBe(0);
      expect(typeof call[1].jobId).toBe('string');
      expect(call[2].jobId).toMatch(/~0$/);
      expect(call[2].priority).toBe(priority);
      for (const candidate of queues) {
        if (candidate !== queue) {
          expect(candidate.add).not.toHaveBeenCalled();
        }
      }
      expect(QueueEvents).toHaveBeenCalledTimes(2);
    },
  );

  it('maps inherited add_rival priority through the common 5-priority rule', async () => {
    const service = new SdgbJobService(
      model as never,
      observability as never,
      registry as never,
      adminQueries as never,
      config as never,
    );
    const queues = (Queue as unknown as jest.Mock).mock.results.map(
      (result) =>
        (result as unknown as { value: { name: string; add: jest.Mock } })
          .value,
    );
    const queue = queues.find(
      (candidate) => candidate.name === SDGB_INTERACTIVE_QUEUE_NAME,
    );

    await service.enqueue({
      jobType: 'add_rival',
      payload: {},
      priority: 4,
    });

    const call = queue?.add.mock.calls[0] as unknown as [
      string,
      unknown,
      { priority: number },
    ];
    expect(call[2].priority).toBe(1);
  });
});

describe('SdgbJobService idempotent enqueue recovery', () => {
  it('safely re-enqueues an idempotent row whose first BullMQ add failed', async () => {
    jest.clearAllMocks();
    const now = new Date();
    const failed = {
      id: 'sdgb-recover',
      jobType: 'add_rival',
      lane: 'interactive',
      priority: 2,
      idempotencyKey: 'idem-1',
      status: 'failed',
      errorCode: 'QUEUE_ENQUEUE_FAILED',
      outcomeUnknown: false,
      payload: {},
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };
    const queued = { ...failed, status: 'queued', errorCode: null };
    const recoveryModel = {
      create: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue(undefined),
    };
    recoveryModel.findOneAndUpdate
      .mockResolvedValueOnce({ ...failed, toObject: () => failed })
      .mockResolvedValueOnce({ ...queued, toObject: () => queued });
    const service = new SdgbJobService(
      recoveryModel as never,
      { recordJobTimelineEvent: jest.fn() } as never,
      { listWorkers: jest.fn().mockResolvedValue([]) } as never,
      { getStatus: jest.fn(), list: jest.fn() } as never,
      {
        get: jest
          .fn()
          .mockImplementation((_key: string, fallback?: unknown) => fallback),
      } as never,
    );
    const queues = (Queue as unknown as jest.Mock).mock.results.map(
      (result) =>
        (result as unknown as { value: { name: string; add: jest.Mock } })
          .value,
    );
    const interactive = queues.find(
      (candidate) => candidate.name === SDGB_INTERACTIVE_QUEUE_NAME,
    );

    await expect(
      service.enqueue({
        jobType: 'add_rival',
        payload: {},
        idempotencyKey: 'idem-1',
      }),
    ).resolves.toMatchObject({ id: 'sdgb-recover', status: 'queued' });
    expect(interactive?.add).toHaveBeenCalledTimes(1);
    expect(recoveryModel.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      {
        idempotencyKey: {
          $eq: 'idem-1',
          $type: 'string',
        },
      },
      expect.anything(),
      { upsert: true, new: true },
    );
    expect(recoveryModel.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'sdgb-recover',
        errorCode: 'QUEUE_ENQUEUE_FAILED',
      }),
      expect.anything(),
      { new: true },
    );
  });
});
