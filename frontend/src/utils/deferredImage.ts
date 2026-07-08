import { useEffect, useRef, useState } from "react";

export const DEFAULT_IMAGE_PLACEHOLDER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='100%25' height='100%25' fill='%23222931'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%238a8f98' font-size='12'>Cover</text></svg>";

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

type DeferredVisibleSrcOptions = {
  disabled?: boolean;
  rootMargin?: string;
  idleTimeout?: number;
};

export function useDeferredVisibleSrc<T extends Element>(
  src: string | null | undefined,
  {
    disabled = false,
    rootMargin = "500px",
    idleTimeout = 700,
  }: DeferredVisibleSrcOptions = {},
) {
  const ref = useRef<T | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const resolvedSrc = disabled
    ? (src ?? undefined)
    : loadedSrc === src
      ? loadedSrc
      : undefined;

  useEffect(() => {
    if (!src || disabled) {
      return;
    }

    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let timeoutId: number | null = null;
    let idleId: IdleCallbackHandle | null = null;

    const requestLoad = () => {
      if (cancelled) {
        return;
      }

      const win = window as WindowWithIdleCallback;
      if (win.requestIdleCallback) {
        idleId = win.requestIdleCallback(
          () => {
            if (!cancelled) {
              setLoadedSrc(src);
            }
          },
          { timeout: idleTimeout },
        );
      } else {
        timeoutId = window.setTimeout(() => {
          if (!cancelled) {
            setLoadedSrc(src);
          }
        }, 0);
      }
    };

    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      requestLoad();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            requestLoad();
          }
        },
        { rootMargin },
      );
      observer.observe(node);
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      const win = window as WindowWithIdleCallback;
      if (idleId !== null && win.cancelIdleCallback) {
        win.cancelIdleCallback(idleId);
      }
    };
  }, [disabled, idleTimeout, rootMargin, src]);

  return [
    ref,
    resolvedSrc,
    Boolean(src) && resolvedSrc !== src,
  ] as const;
}
