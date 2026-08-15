import { JobQueueService } from './job-queue.service';

function redisMock(cursor: unknown = null) {
  return {
    key: jest.fn((key: string) => key),
    getJson: jest.fn().mockResolvedValue(cursor),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(0),
  };
}

describe('JobQueueService claim repair', () => {
  it('clears the complete claim assignment before rebuilding a shared delivery', async () => {
    const snapshot = {
      id: 'job-1',
      status: 'queued',
      botUserFriendCode: 'bot-a',
      routing: {
        version: 2,
        deliveryEpoch: 3,
        lane: 'user_sync',
        assignmentMode: 'claim',
        deliveryMode: 'shared',
      },
      execution: {
        deliveryEpoch: 3,
        attemptsStarted: 2,
        workerId: 'worker-a',
      },
      cabinetFriendship: {
        status: 'running',
        botFriendCode: 'bot-a',
        deliveryEpoch: 3,
        attemptsStarted: 2,
        sdgbJobId: 'sdgb-1',
        lastError: 'old error',
      },
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
    };
    const query = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([snapshot]),
    };
    const jobModel = {
      find: jest.fn().mockReturnValue(query),
      findOneAndUpdate: jest.fn().mockResolvedValue({
        toObject: () => ({
          ...snapshot,
          botUserFriendCode: null,
          routing: { ...snapshot.routing, deliveryEpoch: 4 },
          execution: null,
          cabinetFriendship: {
            status: 'pending',
            botFriendCode: null,
            deliveryEpoch: null,
            attemptsStarted: null,
            sdgbJobId: null,
            lastError: null,
          },
        }),
      }),
    };
    const service = new JobQueueService(
      jobModel as never,
      {} as never,
      {} as never,
      redisMock() as never,
      {
        get: jest
          .fn()
          .mockImplementation((_key: string, fallback?: unknown) => fallback),
      } as never,
    );
    const enqueueWorkerJob = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      getQueue: () => ({ getJob: jest.fn().mockResolvedValue(null) }),
      enqueueWorkerJob,
    });
    const subject = service as unknown as {
      repairMissingQueuedJobs(): Promise<void>;
    };

    await subject.repairMissingQueuedJobs();

    const calls = jobModel.findOneAndUpdate.mock.calls as unknown as Array<
      [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
        Record<string, unknown>,
      ]
    >;
    expect(calls[0][0]).toMatchObject({ id: 'job-1' });
    expect(calls[0][1].$set).toMatchObject({
      botUserFriendCode: null,
      execution: null,
      'cabinetFriendship.status': 'pending',
      'cabinetFriendship.botFriendCode': null,
      'cabinetFriendship.sdgbJobId': null,
      'routing.deliveryEpoch': 4,
    });
    expect(calls[0][2]).toEqual({ new: true });
    expect(enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });
});

describe('JobQueueService repair scan fairness', () => {
  it('scans past healthy deliveries to find a later missing delivery', async () => {
    const snapshots = ['healthy', 'missing'].map((id) => ({
      id,
      status: 'queued',
      botUserFriendCode: null,
      routing: {
        version: 2,
        deliveryEpoch: 1,
        lane: 'background',
        assignmentMode: 'claim',
        deliveryMode: 'shared',
      },
      cabinetFriendship: { status: 'pending' },
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
    }));
    let limit: number | null = null;
    const query = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation((value: number) => {
        limit = value;
        return query;
      }),
      lean: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            limit === null ? snapshots : snapshots.slice(0, limit),
          ),
        ),
    };
    const jobModel = {
      find: jest.fn().mockReturnValue(query),
      findOneAndUpdate: jest.fn().mockResolvedValue({
        toObject: () => ({
          ...snapshots[1],
          routing: { ...snapshots[1].routing, deliveryEpoch: 2 },
        }),
      }),
    };
    const service = new JobQueueService(
      jobModel as never,
      {} as never,
      {} as never,
      redisMock() as never,
      {
        get: jest
          .fn()
          .mockImplementation((key: string, fallback?: unknown) =>
            key === 'DXNET_QUEUE_REPAIR_BATCH_SIZE' ? 1 : fallback,
          ),
      } as never,
    );
    const enqueueWorkerJob = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      getQueue: () => ({
        getJob: jest
          .fn()
          .mockImplementation((deliveryId: string) =>
            deliveryId.startsWith('healthy-')
              ? Promise.resolve({ getState: () => Promise.resolve('waiting') })
              : Promise.resolve(null),
          ),
      }),
      enqueueWorkerJob,
    });

    await (
      service as unknown as { repairMissingQueuedJobs(): Promise<void> }
    ).repairMissingQueuedJobs();

    expect(query.limit).toHaveBeenCalledWith(1_000);
    expect(jobModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'missing' }),
      expect.anything(),
      { new: true },
    );
    expect(enqueueWorkerJob).toHaveBeenCalledTimes(1);
  });
});

describe('JobQueueService terminal mirrors', () => {
  it('does not let a BullMQ failure overwrite completion intent', async () => {
    const jobModel = { updateOne: jest.fn().mockResolvedValue({}) };
    const service = new JobQueueService(
      jobModel as never,
      {} as never,
      {} as never,
      redisMock() as never,
      {
        get: jest
          .fn()
          .mockImplementation((_key: string, fallback?: unknown) => fallback),
      } as never,
    );

    await (
      service as unknown as {
        markBullmqJobFailed(id: string, reason: string): Promise<void>;
      }
    ).markBullmqJobFailed('job-1-e2', 'boom');

    expect(jobModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job-1',
        'routing.deliveryEpoch': 2,
        completionPending: { $ne: true },
      }),
      expect.anything(),
    );
  });
});

describe('JobQueueService deadline fencing', () => {
  it('rechecks the deadline and completion intent in the terminal CAS', async () => {
    const deadlineAt = new Date('2026-08-09T00:00:00.000Z');
    const job = {
      id: 'deadline-job',
      status: 'processing',
      completionPending: false,
      deadlineAt,
      routing: {
        version: 2,
        deliveryEpoch: 4,
        lane: 'user_sync',
        assignmentMode: 'claim',
        deliveryMode: 'shared',
      },
    };
    const query = {
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([job]),
    };
    const jobModel = {
      find: jest.fn().mockReturnValue(query),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
    const service = new JobQueueService(
      jobModel as never,
      {} as never,
      {} as never,
      redisMock() as never,
      {
        get: jest
          .fn()
          .mockImplementation((_key: string, fallback?: unknown) => fallback),
      } as never,
    );

    await (
      service as unknown as { sweepDeadlines(): Promise<void> }
    ).sweepDeadlines();

    const calls = jobModel.updateOne.mock.calls as unknown as Array<
      [Record<string, unknown>, Record<string, unknown>]
    >;
    const filter = calls[0][0] as unknown as {
      id: string;
      deadlineAt: { $lte: unknown };
      completionPending: unknown;
    };
    expect(filter.id).toBe('deadline-job');
    expect(filter.deadlineAt.$lte).toBeInstanceOf(Date);
    expect(filter.completionPending).toEqual({ $ne: true });
  });
});
