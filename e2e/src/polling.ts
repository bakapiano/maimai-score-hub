export interface PollResult {
  done: boolean;
  [key: string]: unknown;
}

export async function waitFor<T extends PollResult>(
  description: string,
  predicate: () => Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      lastError = undefined;
      if (last.done) {
        return last;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const detail = lastError
    ? errorMessage(lastError)
    : JSON.stringify(last ?? null);
  throw new Error(`${description} timed out after ${timeoutMs}ms: ${detail}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
