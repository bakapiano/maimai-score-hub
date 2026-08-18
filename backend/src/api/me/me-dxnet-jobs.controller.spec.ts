import {
  JobCreateBodySchema,
  type JobCreateBody,
} from '@maimai-score-hub/shared';

import { MeDxnetJobsController } from './me-dxnet-jobs.controller';

describe('MeDxnetJobsController.create', () => {
  const friendCode = '123456789012345';

  function makeSubject() {
    const jobs = {
      create: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
    };
    const cabinetScores = {
      withCreateLock: jest.fn(
        async (
          _friendCode: string,
          _kind: string,
          create: () => Promise<unknown>,
        ) => create(),
      ),
    };
    const controller = new MeDxnetJobsController(
      jobs as never,
      {} as never,
      cabinetScores as never,
    );

    return { controller, jobs };
  }

  async function create(body: JobCreateBody) {
    const subject = makeSubject();
    await subject.controller.create({ user: { friendCode } } as never, body);
    return subject.jobs.create;
  }

  it('leaves an omitted difficulty list for the service default', async () => {
    const createJob = await create({ jobType: 'update_score' });

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        friendCode,
        jobType: 'update_score',
        diffsToScrape: undefined,
      }),
    );
  });

  it('forwards the requested difficulty list', async () => {
    const createJob = await create({
      jobType: 'update_score',
      diffsToScrape: [2, 3, 4, 10],
    });

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ diffsToScrape: [2, 3, 4, 10] }),
    );
  });

  it('rejects simultaneous difficulty and music targets in the API schema', () => {
    expect(() =>
      JobCreateBodySchema.parse({
        jobType: 'update_score',
        diffsToScrape: [2, 3],
        musicIds: ['17_3'],
      }),
    ).toThrow('diffsToScrape and musicIds are mutually exclusive');
  });
});
