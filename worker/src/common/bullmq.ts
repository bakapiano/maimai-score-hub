import type { ConnectionOptions, WorkerOptions } from "bullmq";

function getOptionalString(key: string): string | undefined {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : undefined;
}

function getInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

export function createBullmqConnection(): ConnectionOptions {
  const url = getOptionalString("REDIS_URL");
  if (url) {
    return { url, maxRetriesPerRequest: null };
  }

  const password = getOptionalString("REDIS_PASSWORD");
  return {
    host: getOptionalString("REDIS_HOST") ?? "127.0.0.1",
    port: getInt("REDIS_PORT", 6379),
    db: getInt("REDIS_DB", 0),
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  };
}

export function getBullmqPrefix(): string {
  const explicit = getOptionalString("BULLMQ_PREFIX");
  if (explicit) return explicit.replace(/:+$/, "");

  const redisPrefix = getOptionalString("REDIS_KEY_PREFIX") ?? "maimai:";
  return `${redisPrefix.replace(/:+$/, "")}:bull`;
}

export function createBullmqWorkerOptions(): WorkerOptions {
  return {
    connection: createBullmqConnection(),
    prefix: getBullmqPrefix(),
    concurrency: getDxnetWorkerConcurrency(),
  };
}

export function getDxnetWorkerConcurrency(): number {
  return Math.max(
    1,
    getInt("DXNET_WORKER_CONCURRENCY", getInt("MAX_PROCESS_JOBS", 1)),
  );
}
