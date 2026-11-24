/**
 * Stop admitting work at the soft deadline, but drain every admitted task.
 * Unvisited items are untouched and remain due for the next leased sweep.
 * Draining on failure/abort prevents a later phase (or lease owner) from
 * racing writes still in flight in this batch.
 */
export async function runTimeBudgetedBatch<T, R>(options: {
  items: readonly T[];
  concurrency: number;
  budgetMs: number;
  process: (item: T) => Promise<R>;
  signal?: AbortSignal;
}): Promise<R[]> {
  const { items, concurrency, budgetMs, process, signal } = options;
  const deadline = performance.now() + budgetMs;
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      try {
        while (next < items.length && !failed) {
          signal?.throwIfAborted();
          if (performance.now() >= deadline) {
            break;
          }
          const index = next++;
          results[index] = await process(items[index]);
        }
      } catch (error) {
        if (!failed) {
          failure = error;
        }
        failed = true;
      }
    },
  );
  await Promise.all(workers);
  if (failed) {
    throw failure;
  }
  signal?.throwIfAborted();
  return results;
}
