import { ObservabilityQueryService } from './observability-query.service';

describe('ObservabilityQueryService worker history', () => {
  it('maps ClickHouse timeline aggregates into worker trends and errors', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          jobKind: 'dxnet',
          bucket: '2026-08-25T01:35:00.000Z',
          jobType: 'update_score',
          completed: '12',
          failed: '3',
          total: '15',
          successRate: 80,
          avgMs: 1200,
          p50Ms: 1100,
          p95Ms: 1800,
        },
        {
          jobKind: 'sdgb',
          bucket: '2026-08-25T01:35:00.000Z',
          jobType: 'get_user_map',
          completed: '20',
          failed: '0',
          total: '20',
          successRate: 100,
          avgMs: 600,
          p50Ms: 580,
          p95Ms: 800,
        },
      ])
      .mockResolvedValueOnce([
        {
          jobKind: 'dxnet',
          jobType: 'update_score',
          message: 'request timeout',
          count: '3',
        },
      ]);
    const service = new ObservabilityQueryService(
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const since = new Date('2026-08-25T00:00:00.000Z');
    const result = await service.getClickHouseWorkerHistory(
      'prod',
      since,
      5 * 60_000,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INTERVAL 5 MINUTE'),
      {
        environment: 'prod',
        sinceMs: since.getTime(),
      },
    );
    expect(result.dxnet.successRateTrend).toEqual([
      expect.objectContaining({
        jobType: 'update_score',
        completed: 12,
        failed: 3,
        total: 15,
        successRate: 80,
      }),
    ]);
    expect(result.dxnet.durationTrend).toEqual([
      expect.objectContaining({ p50Ms: 1100, p95Ms: 1800 }),
    ]);
    expect(result.dxnet.recentErrors).toEqual([
      expect.objectContaining({ errorClass: 'timeout', count: 3 }),
    ]);
    expect(result.sdgb.successRateTrend).toHaveLength(1);
  });
});

describe('ObservabilityQueryService auto-update overview', () => {
  it('returns normalized auto-update pressure and queue latency trends', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          project: 'fcfs',
          pending: '92',
          p50Ms: '1066267',
          p95Ms: '2266477',
          completePerMinute: '7.8',
          drainEtaMinutes: '11.8',
          recentFailures: '0',
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket: '2026-08-27T12:15:00.000Z',
          project: 'fcfs',
          pending: '92',
          p50Ms: '1066267',
          p95Ms: '2266477',
          completePerMinute: '7.8',
          drainEtaMinutes: '11.8',
          recentFailures: '0',
        },
      ]);
    const countDocuments = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue(259),
    }));
    const service = new ObservabilityQueryService(
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      { countDocuments } as never,
      {} as never,
      {} as never,
    );

    const result = await service.getAutoUpdateOverview('prod', '6h');

    expect(countDocuments).toHaveBeenCalledWith({ enabled: true });
    expect(result.enabledUsers).toBe(259);
    expect(result.projects).toEqual([
      expect.objectContaining({
        project: 'fcfs',
        pending: 92,
        p50Ms: 1066267,
        p95Ms: 2266477,
        completePerMinute: 7.8,
        drainEtaMinutes: 11.8,
      }),
      expect.objectContaining({ project: 'settled', pending: 0 }),
      expect.objectContaining({ project: 'daily', pending: 0 }),
    ]);
    expect(result.trend).toEqual([
      expect.objectContaining({
        project: 'fcfs',
        bucket: '2026-08-27T12:15:00.000Z',
        p50Ms: 1066267,
      }),
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INTERVAL 5 MINUTE'),
      { environment: 'prod', sinceMinutes: 360 },
    );
  });
});
