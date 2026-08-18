import { JobService } from './job.service';

function makeService(input: {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  avgDuration?: number;
}) {
  const jobModel = {
    countDocuments: jest
      .fn()
      .mockImplementation((filter: { status?: string }) => {
        if (filter.status === 'completed') {
          return Promise.resolve(input.completedCount);
        }
        if (filter.status === 'failed') {
          return Promise.resolve(input.failedCount);
        }
        return Promise.resolve(input.totalCount);
      }),
    aggregate: jest
      .fn()
      .mockResolvedValue(
        input.avgDuration === undefined
          ? []
          : [{ avgDuration: input.avgDuration }],
      ),
  };

  return new JobService(
    jobModel as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

describe('JobService.getRecentStats', () => {
  it('calculates success rate using only completed and failed jobs', async () => {
    const service = makeService({
      totalCount: 108,
      completedCount: 6,
      failedCount: 91,
      avgDuration: 1_042_486,
    });

    await expect(service.getRecentStats()).resolves.toEqual({
      totalCount: 108,
      completedCount: 6,
      failedCount: 91,
      successRate: 6.19,
      avgDuration: 1_042_486,
    });
  });

  it('returns zero when there are no terminal jobs', async () => {
    const service = makeService({
      totalCount: 11,
      completedCount: 0,
      failedCount: 0,
    });

    await expect(service.getRecentStats()).resolves.toMatchObject({
      totalCount: 11,
      successRate: 0,
    });
  });
});

describe('JobService prerequisite reuse', () => {
  it('reuses an existing same-Bot prerequisite across redelivery', () => {
    const service = makeService({
      totalCount: 0,
      completedCount: 0,
      failedCount: 0,
    });
    const base = {
      botUserFriendCode: 'bot-a',
      routing: {
        version: 2,
        assignmentMode: 'claim',
        deliveryMode: 'pinned',
      },
      cabinetFriendship: {
        status: 'ready',
        botFriendCode: 'bot-a',
        sdgbJobId: 'sdgb-1',
      },
    };
    const subject = service as unknown as {
      mayReuseCabinetPrerequisite(
        job: Record<string, unknown>,
        botFriendCode: string,
      ): boolean;
    };

    expect(subject.mayReuseCabinetPrerequisite(base, 'bot-a')).toBe(true);
    expect(
      subject.mayReuseCabinetPrerequisite(
        {
          ...base,
          routing: { ...base.routing, deliveryMode: 'shared' },
        },
        'bot-a',
      ),
    ).toBe(true);
    expect(subject.mayReuseCabinetPrerequisite(base, 'bot-b')).toBe(false);
    expect(
      subject.mayReuseCabinetPrerequisite(
        {
          ...base,
          cabinetFriendship: {
            ...base.cabinetFriendship,
            status: 'pending',
          },
        },
        'bot-a',
      ),
    ).toBe(false);
  });
});

describe('JobService execution route fencing', () => {
  it('pins claim continuations to the Bot already stored on the job', () => {
    const service = makeService({
      totalCount: 0,
      completedCount: 0,
      failedCount: 0,
    });
    const subject = service as unknown as {
      assertV2QueueRoute(
        job: Record<string, unknown>,
        queueName: string,
        botFriendCode: string,
      ): void;
    };
    const job = {
      botUserFriendCode: 'bot-a',
      routing: {
        version: 2,
        assignmentMode: 'claim',
        deliveryMode: 'pinned',
        lane: 'background',
      },
    };

    expect(() =>
      subject.assertV2QueueRoute(
        job,
        'dxnet-worker-bot-a-background-jobs',
        'bot-a',
      ),
    ).not.toThrow();
    expect(() =>
      subject.assertV2QueueRoute(
        job,
        'dxnet-worker-bot-b-background-jobs',
        'bot-b',
      ),
    ).toThrow();
  });
});

describe('JobService targeted score input', () => {
  it('resolves chart ids while keeping fcfsOnly independent', async () => {
    const service = makeService({
      totalCount: 0,
      completedCount: 0,
      failedCount: 0,
    });
    const targets = [
      {
        musicId: '100_3',
        title: 'Tell Your World',
        type: 'standard',
        category: 'niconico＆VOCALOID™',
        diff: 3,
        genre: 102,
        level: 19,
      },
    ];
    Object.assign(service, {
      music: {
        resolveScoreFetchTargets: jest
          .fn()
          .mockResolvedValue({ targets, missing: [] }),
      },
    });

    await expect(
      (
        service as unknown as {
          prepareScoreFetchInput(input: unknown): Promise<unknown>;
        }
      ).prepareScoreFetchInput({
        friendCode: '123456789012345',
        jobType: 'update_score',
        musicIds: ['100_3', '100_3'],
        fcfsOnly: true,
      }),
    ).resolves.toMatchObject({
      musicIds: ['100_3'],
      scoreFetchTargets: targets,
      fcfsOnly: true,
    });
  });
});

describe('JobService relationship capacity reservation', () => {
  function capacitySubject(otherOwningJobs: number) {
    const service = makeService({
      totalCount: otherOwningJobs,
      completedCount: 0,
      failedCount: 0,
    });
    Object.assign(service, {
      botStatus: {
        getByFriendCode: jest.fn().mockResolvedValue({ friendCount: 50 }),
      },
    });
    return service as unknown as {
      assertEffectiveFriendCapacity(
        botFriendCode: string,
        currentJobId: string,
      ): Promise<void>;
    };
  }

  it('includes the prospective assignment but excludes the current job', async () => {
    await expect(
      capacitySubject(28).assertEffectiveFriendCapacity('bot-a', 'job-a'),
    ).resolves.toBeUndefined();
    await expect(
      capacitySubject(29).assertEffectiveFriendCapacity('bot-a', 'job-a'),
    ).rejects.toThrow('Bot friend capacity is exhausted');
  });

  it('reserves pinned cabinet fallback work before worker-side addRival', async () => {
    const service = makeService({
      totalCount: 0,
      completedCount: 0,
      failedCount: 0,
    });
    Object.assign(service, {
      friendship: {
        getTargetCabinetUserId: jest.fn().mockResolvedValue(42),
      },
      routingControl: {
        isClaimFlowEnabled: jest.fn().mockReturnValue(false),
      },
    });

    await expect(
      (
        service as unknown as {
          resolveV2CabinetUpdate(input: unknown): Promise<unknown>;
        }
      ).resolveV2CabinetUpdate({
        input: { friendCode: '123456789012345' },
        source: 'user_sync',
        definition: {
          lane: 'user_sync',
          priority: 2,
          claimFlow: 'manual_update',
        },
        control: {},
        healthyBots: [
          {
            friendCode: 'bot-a',
            cabinetUserId: 7,
            friendCount: 10,
            friendsUpdatedAt: new Date().toISOString(),
          },
        ],
        now: new Date(),
      }),
    ).resolves.toEqual({
      assignmentMode: 'pinned',
      botUserFriendCode: 'bot-a',
      cabinetStatus: 'pending',
    });
  });
});
