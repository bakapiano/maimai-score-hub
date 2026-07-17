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
    model.create.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({
        toObject: () => input,
      }),
    );
  });

  it.each([
    ['get_rival_hash', SDGB_PROBE_QUEUE_NAME, 10],
    ['get_user_map', SDGB_PROBE_QUEUE_NAME, 10],
    ['scan_qr', SDGB_INTERACTIVE_QUEUE_NAME, 1],
    ['get_music_score', SDGB_INTERACTIVE_QUEUE_NAME, 1],
    ['add_rival', SDGB_INTERACTIVE_QUEUE_NAME, 5],
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
});
