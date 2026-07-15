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
