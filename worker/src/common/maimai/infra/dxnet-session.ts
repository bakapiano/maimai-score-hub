import { CookieJar } from "tough-cookie";
import makeFetchCookie from "fetch-cookie";

const dxnetSessionChains = new WeakMap<CookieJar, Promise<unknown>>();

export interface DxnetSession {
  send: typeof global.fetch;
  getToken(): string | undefined;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function createDxnetSession(
  cookieJar: CookieJar,
  options: { onCookieChanged?: () => void } = {},
): DxnetSession {
  return {
    send: createCookieFetch(cookieJar, options),
    getToken: () => getMaimaiToken(cookieJar),
    runExclusive: (fn) => runWithDxnetSessionLock(cookieJar, fn),
  };
}

function createCookieFetch(
  realJar: CookieJar,
  options: { onCookieChanged?: () => void } = {},
): typeof global.fetch {
  return makeFetchCookie(
    global.fetch,
    {
      getCookieString: (currentUrl: string) =>
        realJar.getCookieString(currentUrl),
      setCookie: async (
        cookieString: string,
        currentUrl: string,
        opts: { ignoreError: boolean },
      ) => {
        const cookie = await realJar.setCookie(cookieString, currentUrl, opts);
        try {
          options.onCookieChanged?.();
        } catch (err) {
          console.warn("[MaimaiClient] onCookieChanged hook failed:", err);
        }
        return cookie;
      },
    } as unknown as CookieJar,
  );
}

function runWithDxnetSessionLock<T>(
  cookieJar: CookieJar,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = dxnetSessionChains.get(cookieJar) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  dxnetSessionChains.set(
    cookieJar,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function getMaimaiToken(cookieJar: CookieJar): string | undefined {
  const cookies = cookieJar.getCookiesSync("https://maimai.wahlap.com");
  return cookies.find((c) => c.key === "_t")?.value;
}
