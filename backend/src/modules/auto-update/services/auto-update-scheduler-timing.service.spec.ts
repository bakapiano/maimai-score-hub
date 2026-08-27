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
    expect(timing.dailyFullUpdateHour).toBe(2);
    expect(timing.fcfsEnabled).toBe(false);
    expect(timing.fcfsClaimTimeoutMs).toBe(5 * 60_000);
    expect(timing.fcfsRatePerMinute).toBe(8);
    expect(timing.fcfsBurst).toBe(2);
    expect(timing.fcfsMaxMusicIdsPerJob).toBe(32);
    expect(timing.fcfsRateForHealthyBots(4)).toBe(8);
    expect(timing.fcfsRateForHealthyBots(3)).toBe(5);
    expect(timing.fcfsRateForHealthyBots(2)).toBe(3);
    expect(timing.fcfsRateForHealthyBots(1)).toBe(0);
    expect(timing.settledFullUpdateClaimTimeoutMs).toBe(5 * 60_000);
    expect(timing.dailyFullUpdateBatchLimit).toBe(4);
    expect(timing.dailyFullUpdateMaxActive).toBe(8);
    expect(timing.dailyFullUpdateDispatchLimit(0)).toBe(4);
    expect(timing.dailyFullUpdateDispatchLimit(6)).toBe(2);
    expect(timing.dailyFullUpdateDispatchLimit(8)).toBe(0);
  });

  it('reads an independent settled full update batch limit', () => {
    const timing = new AutoUpdateSchedulerTimingService(
      new ConfigService({
        AUTO_UPDATE_MAP_BATCH_LIMIT: 30,
        AUTO_UPDATE_SETTLED_FULL_UPDATE_BATCH_LIMIT: 7,
        AUTO_UPDATE_SETTLED_FULL_UPDATE_MAX_ACTIVE: 10,
        AUTO_UPDATE_DAILY_FULL_UPDATE_HOUR: 3,
        AUTO_UPDATE_DAILY_FULL_UPDATE_BATCH_LIMIT: 5,
        AUTO_UPDATE_DAILY_FULL_UPDATE_MAX_ACTIVE: 6,
        AUTO_UPDATE_TARGETED_FCFS_ENABLED: 'true',
        AUTO_UPDATE_FCFS_CLAIM_TIMEOUT_MS: 123_000,
        AUTO_UPDATE_FCFS_RATE_PER_MINUTE: 6,
        AUTO_UPDATE_FCFS_BURST: 3,
        AUTO_UPDATE_FCFS_MAX_MUSIC_IDS_PER_JOB: 24,
        AUTO_UPDATE_SETTLED_FULL_UPDATE_CLAIM_TIMEOUT_MS: 234_000,
      }),
    );

    expect(timing.mapBatchLimit).toBe(30);
    expect(timing.settledFullUpdateBatchLimit).toBe(7);
    expect(timing.settledFullUpdateMaxActive).toBe(10);
    expect(timing.settledFullUpdateDispatchLimit(2)).toBe(7);
    expect(timing.settledFullUpdateDispatchLimit(8)).toBe(2);
    expect(timing.dailyFullUpdateHour).toBe(3);
    expect(timing.fcfsEnabled).toBe(true);
    expect(timing.fcfsClaimTimeoutMs).toBe(123_000);
    expect(timing.fcfsRatePerMinute).toBe(6);
    expect(timing.fcfsBurst).toBe(3);
    expect(timing.fcfsMaxMusicIdsPerJob).toBe(24);
    expect(timing.fcfsRateForHealthyBots(4)).toBe(6);
    expect(timing.settledFullUpdateClaimTimeoutMs).toBe(234_000);
    expect(timing.dailyFullUpdateDispatchLimit(0)).toBe(5);
    expect(timing.dailyFullUpdateDispatchLimit(4)).toBe(2);
  });
});
