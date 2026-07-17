import { ConfigService } from '@nestjs/config';

import { AutoUpdateSchedulerTimingService } from './auto-update-scheduler-timing.service';

describe('AutoUpdateSchedulerTimingService', () => {
  it('defaults settled full update batches to four', () => {
    const timing = new AutoUpdateSchedulerTimingService(new ConfigService());

    expect(timing.rivalBatchLimit).toBe(480);
    expect(timing.mapBatchLimit).toBe(120);
    expect(timing.settledFullUpdateBatchLimit).toBe(4);
  });

  it('reads an independent settled full update batch limit', () => {
    const timing = new AutoUpdateSchedulerTimingService(
      new ConfigService({
        AUTO_UPDATE_MAP_BATCH_LIMIT: 30,
        AUTO_UPDATE_SETTLED_FULL_UPDATE_BATCH_LIMIT: 7,
      }),
    );

    expect(timing.mapBatchLimit).toBe(30);
    expect(timing.settledFullUpdateBatchLimit).toBe(7);
  });
});
