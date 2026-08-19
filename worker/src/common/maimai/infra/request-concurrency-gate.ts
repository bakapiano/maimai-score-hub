type Release = () => void;

interface GateEntry {
  priority: number;
  sequence: number;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Priority-aware semaphore for long-lived response bodies. */
export class RequestConcurrencyGate {
  private active = 0;
  private sequence = 0;
  private readonly queue: GateEntry[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("request concurrency limit must be a positive integer");
    }
    this.limit = limit;
  }

  acquire(priority: number, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<Release>((resolve, reject) => {
      const entry: GateEntry = {
        priority,
        sequence: this.sequence++,
        resolve,
        reject,
        signal,
      };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const index = this.nextIndex();
      const [entry] = this.queue.splice(index, 1);
      entry.signal?.removeEventListener("abort", entry.onAbort!);
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal));
        continue;
      }

      this.active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }

  private nextIndex(): number {
    let best = 0;
    for (let index = 1; index < this.queue.length; index++) {
      const current = this.queue[index];
      const selected = this.queue[best];
      if (
        current.priority > selected.priority ||
        (current.priority === selected.priority &&
          current.sequence < selected.sequence)
      ) {
        best = index;
      }
    }
    return best;
  }
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("request aborted");
}
