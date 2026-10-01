import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { CabinetScoreSyncService } from './cabinet-score-sync.service';

function setup() {
  const job = {
    id: 'job',
    jobType: 'get_music_score',
    ownerUserId: 'owner',
    ownerFriendCode: 'friend',
    payload: { expectedCabinetUserId: 123 },
    cleanupStatus: 'succeeded',
  };
  const jobs = {
    getEntity: jest.fn().mockResolvedValue(job),
    getMusicScoreCompletionForWorker: jest.fn().mockResolvedValue(null),
    assertWorkerExecution: jest.fn().mockResolvedValue(undefined),
    completeMusicScoreFinalization: jest
      .fn()
      .mockResolvedValue({ id: 'job', status: 'completed' }),
    patchFromWorker: jest.fn().mockResolvedValue({ status: 'failed' }),
  };
  const syncs = {
    createFromUserMusic: jest
      .fn()
      .mockResolvedValue({ id: 'sync', scores: [], changedChartCount: 0 }),
  };
  const assertActive = jest.fn();
  const leases = {
    run: jest
      .fn()
      .mockImplementation(
        async (
          _options,
          task: (ctx: { assertActive: () => void }) => Promise<unknown>,
        ) => ({ acquired: true, value: await task({ assertActive }) }),
      ),
  };
  const service = new CabinetScoreSyncService(
    {} as never,
    jobs as never,
    { getById: jest.fn().mockResolvedValue({ cabinetUserId: 123 }) } as never,
    syncs as never,
    {} as never,
    leases as never,
  );
  return { service, jobs, syncs, leases, assertActive };
}

const completion = {
  status: 'completed' as const,
  result: { cabinetUserId: 123, musicDetails: [] },
};

describe('cabinet score result commits', () => {
  it('returns a verified receipt before checking the cleared active execution', async () => {
    const { service, jobs, syncs } = setup();
    jobs.getMusicScoreCompletionForWorker.mockResolvedValue({
      id: 'job',
      status: 'completed',
    });
    await expect(
      service.patchFromWorker('job', completion),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(jobs.assertWorkerExecution).not.toHaveBeenCalled();
    expect(syncs.createFromUserMusic).not.toHaveBeenCalled();
  });

  it('protects an acknowledged commit from a late failure report', async () => {
    const { service, jobs } = setup();
    jobs.getMusicScoreCompletionForWorker.mockResolvedValue({
      id: 'job',
      status: 'completed',
    });
    await expect(
      service.patchFromWorker('job', {
        status: 'failed',
        errorCode: 'RESULT_COMMIT_TIMEOUT',
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(jobs.patchFromWorker).not.toHaveBeenCalled();
  });

  it('serializes duplicate commits across backend replicas', async () => {
    const { service, leases, syncs } = setup();
    leases.run.mockResolvedValue({ acquired: false });
    await expect(
      service.patchFromWorker('job', completion),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(syncs.createFromUserMusic).not.toHaveBeenCalled();
  });

  it('keeps the execution fence on all first-time writes', async () => {
    const { service, jobs, syncs } = setup();
    jobs.assertWorkerExecution.mockRejectedValue(
      new ConflictException('stale execution'),
    );
    await expect(
      service.patchFromWorker('job', completion),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(syncs.createFromUserMusic).not.toHaveBeenCalled();
  });

  it('requires cleanup and rechecks the execution before completing', async () => {
    const { service, jobs, assertActive } = setup();
    await expect(
      service.patchFromWorker('job', completion),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(jobs.assertWorkerExecution).toHaveBeenCalledTimes(2);
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(jobs.completeMusicScoreFinalization).toHaveBeenCalledTimes(1);
  });
});
