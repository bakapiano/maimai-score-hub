/**
 * Console-tap log shipper. Wraps console.log/warn/error so every line is
 * also buffered and POSTed in batches to backend's /worker-logs/:kind/ingest.
 * Designed to fail-open: any shipping error is swallowed so the worker
 * keeps running.
 *
 * Usage at process startup:
 *   import { startLogShipper } from "./log-shipper.ts";
 *   startLogShipper({ backendUrl, kind: "sdgb", workerId });
 */
type Level = "log" | "warn" | "error";
type Entry = { ts: string; level: Level; message: string };

interface Opts {
  backendUrl: string;
  kind: "sdgb" | "dxnet";
  workerId: string;
  /** Flush either when buffer hits this many entries or on the interval. */
  maxBatch?: number;
  flushIntervalMs?: number;
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

export function startLogShipper(opts: Opts): { stop: () => void } {
  const backendUrl = opts.backendUrl.replace(/\/$/, "");
  const url = `${backendUrl}/api/worker-logs/${opts.kind}/ingest`;
  const maxBatch = opts.maxBatch ?? 100;
  const flushIntervalMs = opts.flushIntervalMs ?? 5_000;

  const buffer: Entry[] = [];
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  function push(level: Level, args: unknown[]) {
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

  let flushing = false;
  async function flush(): Promise<void> {
    if (flushing) return;
    if (buffer.length === 0) return;
    flushing = true;
    // Drain everything currently buffered. New entries piled on during the
    // POST are picked up by the next flush.
    const batch = buffer.splice(0, buffer.length);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workerId: opts.workerId,
            entries: batch,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fail-open. Don't put the lines back — that would cause unbounded
      // growth if backend is down. Local stdout still has them via origLog.
    } finally {
      flushing = false;
    }
  }

  const interval = setInterval(() => void flush(), flushIntervalMs);
  // Best-effort shutdown flush.
  const onExit = () => {
    clearInterval(interval);
    void flush();
  };
  process.once("beforeExit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  return {
    stop: () => {
      clearInterval(interval);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}
