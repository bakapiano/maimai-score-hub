import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type { SdgbWorkerUserMapEntry } from '@maimai-score-hub/shared';

import { AUTO_UPDATE_BACKOFF_POLICY } from '../auto-update-backoff';
import {
  AutoUpdateProbeStateEntity,
  type AutoUpdateTier,
} from '../schemas/auto-update-probe-state.schema';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

function getPositiveInt(config: ConfigService, key: string, fallback: number) {
  const raw = config.get<string | number>(key);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function maxDate(...dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (!valid.length) {
    return null;
  }
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

export function countRivalDetails(
  music: Array<{ userRivalMusicDetailList?: unknown[] }>,
) {
  return music.reduce(
    (sum, item) => sum + (item.userRivalMusicDetailList?.length ?? 0),
    0,
  );
}

function deterministicOffsetMs(key: string, moduloMs: number): number {
  const digest = createHash('sha256').update(key).digest();
  const value = digest.readUInt32BE(0);
  return value % Math.max(1, moduloMs);
}

@Injectable()
export class AutoUpdateSchedulerTimingService {
  readonly cronExpr: string;
  readonly hotIntervalMs: number;
  readonly warmIntervalMs: number;
  readonly coldIntervalMs: number;
  readonly hotSessionMs: number;
  readonly warmMaxIdleMs: number;
  readonly batchLimit: number;
  readonly mapBatchLimit: number;
  readonly concurrency: number;
  readonly mapConcurrency: number;
  readonly rivalTimeoutMs: number;
  readonly mapTimeoutMs: number;
  readonly recentEventCooldownMs: number;
  readonly recentEventDelayMs: number;
  readonly settledFullUpdateDelayMs: number;
  readonly settledFullUpdateRetryMs: number;
  readonly mapHotIntervalMs: number;
  readonly mapWarmIntervalMs: number;
  readonly mapColdIntervalMs: number;

  constructor(config: ConfigService) {
    this.cronExpr = config.get<string>('AUTO_UPDATE_CRON', '*/1 * * * *');
    this.hotIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_HOT_INTERVAL_MS',
      10 * MINUTE,
    );
    this.warmIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_WARM_INTERVAL_MS',
      30 * MINUTE,
    );
    this.coldIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_COLD_INTERVAL_MS',
      HOUR,
    );
    this.hotSessionMs = getPositiveInt(
      config,
      'AUTO_UPDATE_HOT_SESSION_MS',
      90 * MINUTE,
    );
    this.warmMaxIdleMs = getPositiveInt(
      config,
      'AUTO_UPDATE_WARM_MAX_IDLE_MS',
      7 * DAY,
    );
    this.batchLimit = getPositiveInt(
      config,
      'AUTO_UPDATE_RIVAL_BATCH_LIMIT',
      480,
    );
    this.mapBatchLimit = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_BATCH_LIMIT',
      120,
    );
    this.concurrency = getPositiveInt(
      config,
      'AUTO_UPDATE_RIVAL_CONCURRENCY',
      4,
    );
    this.mapConcurrency = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_CONCURRENCY',
      2,
    );
    this.rivalTimeoutMs = getPositiveInt(
      config,
      'AUTO_UPDATE_RIVAL_TIMEOUT_MS',
      120_000,
    );
    this.mapTimeoutMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_TIMEOUT_MS',
      60_000,
    );
    this.recentEventCooldownMs = getPositiveInt(
      config,
      'AUTO_UPDATE_RECENT_EVENT_COOLDOWN_MS',
      30 * MINUTE,
    );
    this.recentEventDelayMs = getPositiveInt(
      config,
      'AUTO_UPDATE_RECENT_EVENT_DELAY_MS',
      3 * MINUTE,
    );
    this.settledFullUpdateDelayMs = getPositiveInt(
      config,
      'AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS',
      45 * MINUTE,
    );
    this.settledFullUpdateRetryMs = getPositiveInt(
      config,
      'AUTO_UPDATE_SETTLED_FULL_UPDATE_RETRY_MS',
      10 * MINUTE,
    );
    this.mapHotIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_HOT_INTERVAL_MS',
      30 * MINUTE,
    );
    this.mapWarmIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_WARM_INTERVAL_MS',
      HOUR,
    );
    this.mapColdIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_COLD_INTERVAL_MS',
      HOUR,
    );
  }

  initialRivalProbeAt(friendCode: string, now: Date): Date {
    return new Date(
      now.getTime() + deterministicOffsetMs(friendCode, this.coldIntervalMs),
    );
  }

  initialMapProbeAt(friendCode: string, now: Date): Date {
    return new Date(
      now.getTime() +
        deterministicOffsetMs(`map:${friendCode}`, this.mapColdIntervalMs),
    );
  }

  priorityForTier(tier: AutoUpdateTier): number {
    if (tier === 'hot') {
      return 30;
    }
    if (tier === 'warm') {
      return 10;
    }
    return 0;
  }

  intervalForTier(tier: AutoUpdateTier): number {
    if (tier === 'hot') {
      return this.hotIntervalMs;
    }
    if (tier === 'warm') {
      return this.warmIntervalMs;
    }
    return this.coldIntervalMs;
  }

  mapIntervalForTier(tier: AutoUpdateTier): number {
    if (tier === 'hot') {
      return this.mapHotIntervalMs;
    }
    if (tier === 'warm') {
      return this.mapWarmIntervalMs;
    }
    return this.mapColdIntervalMs;
  }

  nextProbeAt(
    tier: AutoUpdateTier,
    now: Date,
    state: AutoUpdateProbeStateEntity,
  ): Date {
    const base = this.intervalForTier(tier);
    const habitMultiplier = Number.isFinite(state.habitMultiplier)
      ? state.habitMultiplier
      : 1;
    const loadMultiplier = Number.isFinite(state.loadMultiplier)
      ? state.loadMultiplier
      : 1;
    const ms = Math.max(
      MINUTE,
      Math.floor(base * habitMultiplier * loadMultiplier),
    );
    return new Date(now.getTime() + ms);
  }

  nextMapProbeAt(
    tier: AutoUpdateTier,
    now: Date,
    state: AutoUpdateProbeStateEntity,
  ): Date {
    const base = this.mapIntervalForTier(tier);
    const loadMultiplier = Number.isFinite(state.loadMultiplier)
      ? state.loadMultiplier
      : 1;
    return new Date(
      now.getTime() + Math.max(MINUTE, Math.floor(base * loadMultiplier)),
    );
  }

  shouldProbeRivalNow(state: AutoUpdateProbeStateEntity, now: Date): boolean {
    if (!state.lastRivalProbeAt) {
      return true;
    }
    return (
      now.getTime() - state.lastRivalProbeAt.getTime() >=
      this.intervalForTier(state.tier)
    );
  }

  mapFingerprint(maps: SdgbWorkerUserMapEntry[]): {
    mapFingerprint: string;
    mapDistanceSum: number;
    rowCount: number;
  } {
    const pairs = maps
      .filter((m) => Number.isFinite(m.mapId) && Number.isFinite(m.distance))
      .map((m) => [m.mapId, m.distance] as const)
      .sort((a, b) => a[0] - b[0]);
    const stable = pairs
      .map(([mapId, distance]) => `${mapId}:${distance}`)
      .join('|');
    return {
      mapFingerprint: createHash('sha256').update(stable).digest('hex'),
      mapDistanceSum: pairs.reduce((sum, [, distance]) => sum + distance, 0),
      rowCount: pairs.length,
    };
  }

  decayTier(state: AutoUpdateProbeStateEntity, now: Date): AutoUpdateTier {
    const lastSignal = maxDate(state.lastScoreChangedAt, state.lastMapDeltaAt);
    if (!lastSignal) {
      return 'cold';
    }
    const idleMs = now.getTime() - lastSignal.getTime();
    if (state.tier === 'hot' && idleMs <= this.hotSessionMs) {
      return 'hot';
    }
    if (idleMs <= this.warmMaxIdleMs) {
      return 'warm';
    }
    return 'cold';
  }

  rivalBackoffDelayMs(failureCount: number): number {
    return Math.min(
      AUTO_UPDATE_BACKOFF_POLICY.capMs,
      Math.floor(
        AUTO_UPDATE_BACKOFF_POLICY.baseMs *
          Math.pow(AUTO_UPDATE_BACKOFF_POLICY.factor, failureCount - 1),
      ),
    );
  }

  mapBackoffDelayMs(failureCount: number): number {
    return Math.min(HOUR, 5 * MINUTE * failureCount);
  }

  recentEventRetryDelayMs(failureCount: number): number {
    return Math.min(6 * HOUR, 30 * MINUTE * failureCount);
  }
}
