import { CookieJar } from "tough-cookie";
import makeFetchCookie from "fetch-cookie";
import { ProxyAgent, type Dispatcher } from "undici";

const dxnetSessionChains = new WeakMap<CookieJar, Promise<unknown>>();
let dxnetDispatcher: Dispatcher | null | undefined;

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
  const dispatcher = getDxnetDispatcher();
  const baseFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    global.fetch(input, {
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher })) as typeof global.fetch;
  return makeFetchCookie(baseFetch, {
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
  } as unknown as CookieJar);
}

function getDxnetDispatcher(): Dispatcher | null {
  if (dxnetDispatcher !== undefined) {
    return dxnetDispatcher;
  }
  const proxyUrl = process.env.DXNET_OUTBOUND_PROXY_URL?.trim();
  dxnetDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return dxnetDispatcher;
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
