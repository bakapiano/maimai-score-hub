import { runTimeBudgetedBatch } from './time-budgeted-batch';

describe('runTimeBudgetedBatch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('limits concurrency and returns results in input order', async () => {
    let active = 0;
    let peak = 0;
    const result = runTimeBudgetedBatch({
      items: [1, 2, 3, 4],
      concurrency: 2,
      budgetMs: 1000,
      process: async (value) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10 / value));
        active--;
        return value * 2;
      },
    });
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual([2, 4, 6, 8]);
    expect(peak).toBe(2);
  });

  it('drains tasks at the deadline without touching deferred items', async () => {
    const process = jest.fn(async (value: number) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return value;
    });
    const result = runTimeBudgetedBatch({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      budgetMs: 100,
      process,
    });
    await jest.advanceTimersByTimeAsync(99);
    expect(process).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([1, 2]);
    expect(process.mock.calls).toEqual([[1], [2]]);
  });

  it('waits for other in-flight work before propagating a failure', async () => {
    const error = new Error('write failed');
    let drained = false;
    const process = jest.fn(async (value: number) => {
      await new Promise((resolve) =>
        setTimeout(resolve, value === 1 ? 10 : 100),
      );
      if (value === 1) {
        throw error;
      }
      drained = true;
      return value;
    });
    const result = runTimeBudgetedBatch({
      items: [1, 2, 3],
      concurrency: 2,
      budgetMs: 1000,
      process,
    });
    const assertion = expect(result).rejects.toBe(error);
    await jest.advanceTimersByTimeAsync(10);
    expect(drained).toBe(false);
    await jest.advanceTimersByTimeAsync(90);
    await assertion;
    expect(drained).toBe(true);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('drains the last task and still propagates lease cancellation', async () => {
    const controller = new AbortController();
    const error = new Error('lease lost');
    let drained = false;
    const result = runTimeBudgetedBatch({
      items: [1],
      concurrency: 2,
      budgetMs: 1000,
      signal: controller.signal,
      process: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        drained = true;
      },
    });
    const assertion = expect(result).rejects.toBe(error);
    controller.abort(error);
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(drained).toBe(true);
  });

  it('does not start any work after cancellation or an expired budget', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease lost'));
    const process = jest.fn();
    await expect(
      runTimeBudgetedBatch({
        items: [1],
        concurrency: 1,
        budgetMs: 10,
        signal: controller.signal,
        process,
      }),
    ).rejects.toThrow('lease lost');
    await expect(
      runTimeBudgetedBatch({
        items: [1],
        concurrency: 1,
        budgetMs: 0,
        process,
      }),
    ).resolves.toEqual([]);
    expect(process).not.toHaveBeenCalled();
  });
});
