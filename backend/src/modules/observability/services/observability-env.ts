import type { ConfigService } from '@nestjs/config';

export type ObservabilityEnvironment = 'prod' | 'dev';

export function getObservabilityEnvironment(
  config: ConfigService,
): ObservabilityEnvironment {
  const raw = config.get<string>('OBSERVABILITY_ENV')?.trim().toLowerCase();
  if (raw === 'prod' || raw === 'dev') {
    return raw;
  }
  return config.get<string>('NODE_ENV') === 'production' ? 'prod' : 'dev';
}

export function parseObservabilityEnvironment(
  value: unknown,
): ObservabilityEnvironment {
  return value === 'dev' ? 'dev' : 'prod';
}

export function getPositiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function isObservabilityEnabled(config: ConfigService): boolean {
  const explicit = config.get<string>('OBSERVABILITY_ENABLED');
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return ['1', 'true', 'yes', 'on'].includes(explicit.toLowerCase());
  }
  return Boolean(config.get<string>('CLICKHOUSE_URL'));
}
