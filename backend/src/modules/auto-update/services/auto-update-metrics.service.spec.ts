/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { AutoUpdateMetricsService } from './auto-update-metrics.service';

function aggregateResult<T>(value: T) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

describe('AutoUpdateMetricsService', () => {
  it('records one ClickHouse pressure row per auto-update project', async () => {
    const stateModel = {
      countDocuments: jest.fn(() => aggregateResult(259)),
      aggregate: jest
        .fn()
        .mockReturnValueOnce(
          aggregateResult([
            { pending: 92, queuePercentilesMs: [1_066_267, 2_266_477] },
          ]),
        )
        .mockReturnValueOnce(
          aggregateResult([
            { pending: 4, queuePercentilesMs: [60_000, 90_000] },
          ]),
        ),
    };
    const taskModel = {
      aggregate: jest
        .fn()
        .mockReturnValueOnce(
          aggregateResult([
            { pending: 3, queuePercentilesMs: [30_000, 45_000] },
          ]),
        )
        .mockReturnValueOnce(
          aggregateResult([
            { _id: 'fcfs_enrichment', count: 117 },
            { _id: 'settled_full_update', count: 15 },
            { _id: 'daily_full_update', count: 3 },
          ]),
        )
        .mockReturnValueOnce(
          aggregateResult([{ _id: 'settled_full_update', count: 1 }]),
        ),
    };
    const observability = { recordStructuredLogs: jest.fn() };
    const service = new AutoUpdateMetricsService(
      stateModel as never,
      taskModel as never,
      observability as never,
      {} as never,
    );

    await service.recordSnapshot(new Date('2026-08-27T12:15:00.000Z'));

    expect(observability.recordStructuredLogs).toHaveBeenCalledWith({
      service: 'backend',
      workerKind: 'backend',
      entries: [
        expect.objectContaining({
          eventName: 'auto_update_pressure_snapshot',
          attrs: expect.objectContaining({
            project: 'fcfs',
            enabledUsers: 259,
            pending: 92,
            queueP50Ms: 1_066_267,
            queueP95Ms: 2_266_477,
            completePerMinute: 7.8,
            drainEtaMinutes: 11.8,
          }),
        }),
        expect.objectContaining({
          attrs: expect.objectContaining({
            project: 'settled',
            pending: 4,
            completePerMinute: 1,
            drainEtaMinutes: 4,
            recentFailures: 1,
          }),
        }),
        expect.objectContaining({
          attrs: expect.objectContaining({
            project: 'daily',
            pending: 3,
            completePerMinute: 0.2,
            drainEtaMinutes: 15,
          }),
        }),
      ],
    });
  });

  it('uses a minute Redis fence across backend replicas', async () => {
    const countDocuments = jest.fn();
    const redis = {
      key: jest.fn((key: string) => `maimai:${key}`),
      setNx: jest.fn().mockResolvedValue(false),
    };
    const service = new AutoUpdateMetricsService(
      { countDocuments } as never,
      {} as never,
      {} as never,
      redis as never,
    );

    await (
      service as unknown as { recordSnapshotOnce(): Promise<void> }
    ).recordSnapshotOnce();

    expect(redis.key).toHaveBeenCalledWith(
      expect.stringMatching(/^observability:auto-update-pressure:/),
    );
    expect(redis.setNx).toHaveBeenCalledWith(
      expect.stringMatching(/^maimai:observability:auto-update-pressure:/),
      '1',
      120_000,
    );
    expect(countDocuments).not.toHaveBeenCalled();
  });
});
