import { ConfigService } from '@nestjs/config';

import { AutoUpdateSchedulerTimingService } from './auto-update-scheduler-timing.service';

describe('AutoUpdateSchedulerTimingService', () => {
  it('defaults settled full update dispatch to a twelve-job waterline', () => {
    const timing = new AutoUpdateSchedulerTimingService(new ConfigService());

    expect(timing.rivalBatchLimit).toBe(480);
    expect(timing.mapBatchLimit).toBe(120);
    expect(timing.settledFullUpdateBatchLimit).toBe(12);
    expect(timing.settledFullUpdateMaxActive).toBe(12);
    expect(timing.settledFullUpdateDispatchLimit(0)).toBe(12);
    expect(timing.settledFullUpdateDispatchLimit(5)).toBe(7);
    expect(timing.settledFullUpdateDispatchLimit(12)).toBe(0);
    expect(timing.settledFullUpdateDispatchLimit(20)).toBe(0);
  });

  it('reads an independent settled full update batch limit', () => {
    const timing = new AutoUpdateSchedulerTimingService(
      new ConfigService({
        AUTO_UPDATE_MAP_BATCH_LIMIT: 30,
        AUTO_UPDATE_SETTLED_FULL_UPDATE_BATCH_LIMIT: 7,
        AUTO_UPDATE_SETTLED_FULL_UPDATE_MAX_ACTIVE: 10,
      }),
    );

    expect(timing.mapBatchLimit).toBe(30);
    expect(timing.settledFullUpdateBatchLimit).toBe(7);
    expect(timing.settledFullUpdateMaxActive).toBe(10);
    expect(timing.settledFullUpdateDispatchLimit(2)).toBe(7);
    expect(timing.settledFullUpdateDispatchLimit(8)).toBe(2);
  });
});
