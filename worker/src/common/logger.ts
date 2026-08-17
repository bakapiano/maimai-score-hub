/**
 * Console-tap logger. Wraps console.log/warn/error so every line is also
 * buffered and POSTed in batches to backend's /workers/logs/:kind/batches.
 * Designed to fail-open: shipping errors are swallowed so the worker keeps
 * running.
 */
import { backendFetchWithRetry } from "./backend/http.ts";

type Level = "log" | "warn" | "error";
type Entry = { ts: string; level: Level; message: string };

interface LoggerOptions {
  backendUrl: string;
  kind: "sdgb" | "dxnet";
  workerId: string;
  /** Flush either when buffer hits this many entries or on the interval. */
  maxBatch?: number;
  flushIntervalMs?: number;
  sendBatch?: (entries: readonly Entry[]) => Promise<void>;
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export interface LoggerLifecycle {
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export function startLogger(opts: LoggerOptions): LoggerLifecycle {
  const backendUrl = opts.backendUrl.replace(/\/$/, "");
  const url = `${backendUrl}/api/v1/workers/logs/${opts.kind}/batches`;
  const maxBatch = opts.maxBatch ?? 100;
  const flushIntervalMs = opts.flushIntervalMs ?? 10_000;

  const buffer: Entry[] = [];
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  let stopped = false;

  function push(level: Level, args: unknown[]) {
    if (stopped) return;
    buffer.push({
      ts: new Date().toISOString(),
      level,
      message: args.map(fmtArg).join(" "),
    });
    if (buffer.length >= maxBatch) {
      void flush();
    }
  }

  console.log = (...args: unknown[]) => {
    origLog(...args);
    push("log", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    push("warn", args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    push("error", args);
  };

  let activeFlush: Promise<void> | null = null;
  function flush(): Promise<void> {
    if (activeFlush) return activeFlush;
    if (buffer.length === 0) return Promise.resolve();
    const batch = buffer.splice(0, buffer.length);
    activeFlush = flushBatch(batch).finally(() => {
      activeFlush = null;
    });
    return activeFlush;
  }

  async function flushBatch(batch: Entry[]): Promise<void> {
    try {
      if (opts.sendBatch) {
        await opts.sendBatch(batch);
        return;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const apiSecret =
          process.env.API_SHARED_SECRET || process.env.ADMIN_PASSWORD;
        await backendFetchWithRetry(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiSecret ? { "X-API-Secret": apiSecret } : {}),
            },
            body: JSON.stringify({
              workerId: opts.workerId,
              entries: batch,
            }),
            signal: ctrl.signal,
          },
          { maxAttempts: 1 },
        );
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fail-open. Local stdout already has these lines via origLog/origWarn/origError.
    }
  }

  const interval = setInterval(() => void flush(), flushIntervalMs);
  const onExit = () => {
    clearInterval(interval);
    void flush();
  };
  process.once("beforeExit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);
  return {
    flush,
    stop: async () => {
      clearInterval(interval);
      process.removeListener("beforeExit", onExit);
      process.removeListener("SIGINT", onExit);
      process.removeListener("SIGTERM", onExit);
      stopped = true;
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      if (activeFlush) await activeFlush;
      while (buffer.length > 0) await flush();
    },
  };
}
