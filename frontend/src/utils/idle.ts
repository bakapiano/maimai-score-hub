type IdleCallbackHandle = number;
type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};
type WindowWithIdleCallback = Window &
  typeof globalThis & {
    requestIdleCallback?: (
      callback: (deadline: IdleDeadlineLike) => void,
      options?: { timeout?: number },
    ) => IdleCallbackHandle;
    cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
  };

export function scheduleIdleTask(callback: () => void, timeout = 700) {
  const win = window as WindowWithIdleCallback;
  if (win.requestIdleCallback) {
    const idleId = win.requestIdleCallback(callback, { timeout });
    return () => win.cancelIdleCallback?.(idleId);
  }

  const timeoutId = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timeoutId);
}

export function runWhenIdle<T>(callback: () => T, timeout = 700) {
  return new Promise<T>((resolve) => {
    scheduleIdleTask(() => resolve(callback()), timeout);
  });
}
