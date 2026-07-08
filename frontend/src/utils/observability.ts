type AttrValue = string | number | boolean | null;
type Attrs = Record<string, AttrValue | AttrValue[]>;

type RumEvent = {
  ts?: string;
  sessionId?: string;
  friendCode?: string;
  routeTemplate: string;
  pageUrlHash?: string;
  referrerHash?: string;
  browser?: string;
  os?: string;
  deviceType?: string;
  fcpMs?: number;
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  ttfbMs?: number;
  loadMs?: number;
  apiWaitMs?: number;
  jsError?: boolean;
  errorName?: string;
  errorMessageHash?: string;
  traceId?: string;
  attrs?: Attrs;
};

type AnalyticsEvent = {
  ts?: string;
  eventName: string;
  friendCode?: string;
  sessionId?: string;
  routeTemplate?: string;
  source?: string;
  appVersion?: string;
  properties?: Attrs;
};

const SESSION_KEY = "msh_observability_session";
const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000;

let currentRoute = "/";
let currentFriendCode = "";
let installed = false;
let flushing = false;
const rumQueue: RumEvent[] = [];
const analyticsQueue: AnalyticsEvent[] = [];

export function setObservabilityContext(input: {
  routeTemplate?: string;
  friendCode?: string | null;
}): void {
  if (input.routeTemplate) {
    currentRoute = input.routeTemplate;
  }
  if (input.friendCode !== undefined) {
    currentFriendCode = input.friendCode ?? "";
  }
}

export function installObservability(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  installFetchObserver();
  installErrorObservers();
  installWebVitalObservers();
  window.setInterval(() => void flushObservability(), FLUSH_INTERVAL_MS);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushObservability(true);
    }
  });
  window.addEventListener("beforeunload", () => {
    void flushObservability(true);
  });
}

export function recordRumEvent(event: Omit<RumEvent, "sessionId">): void {
  rumQueue.push(withCommonRumFields(event));
  if (rumQueue.length >= MAX_BATCH_SIZE) {
    void flushObservability();
  }
}

export function recordAnalyticsEvent(
  eventName: string,
  properties: Attrs = {},
): void {
  analyticsQueue.push({
    ts: new Date().toISOString(),
    eventName,
    friendCode: currentFriendCode,
    sessionId: getSessionId(),
    routeTemplate: currentRoute,
    source: "frontend",
    appVersion: getAppVersion(),
    properties,
  });
  if (analyticsQueue.length >= MAX_BATCH_SIZE) {
    void flushObservability();
  }
}

export function recordPageView(routeTemplate: string): void {
  setObservabilityContext({ routeTemplate });
  recordAnalyticsEvent("page_view");
  recordRumEvent({
    routeTemplate,
    pageUrlHash: hashString(window.location.href),
    referrerHash: hashString(document.referrer),
    browser: getBrowser(),
    os: getOs(),
    deviceType: getDeviceType(),
    loadMs: getNavigationLoadMs(),
    ttfbMs: getNavigationTtfbMs(),
  });
}

async function flushObservability(useBeacon = false): Promise<void> {
  if (flushing) {
    return;
  }
  const rum = rumQueue.splice(0, rumQueue.length);
  const analytics = analyticsQueue.splice(0, analyticsQueue.length);
  if (!rum.length && !analytics.length) {
    return;
  }
  flushing = true;
  try {
    await Promise.all([
      postBatch("/api/v1/observability/rum", { events: rum }, useBeacon),
      postBatch("/api/v1/observability/events", { events: analytics }, useBeacon),
    ]);
  } catch {
    // Observability must never affect product flows.
  } finally {
    flushing = false;
  }
}

async function postBatch(
  path: string,
  body: { events: unknown[] },
  useBeacon: boolean,
): Promise<void> {
  if (!body.events.length) {
    return;
  }
  const raw = JSON.stringify(body);
  if (useBeacon && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(
      path,
      new Blob([raw], { type: "application/json" }),
    );
    if (sent) {
      return;
    }
  }
  await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
    keepalive: useBeacon,
  });
}

function withCommonRumFields(event: Omit<RumEvent, "sessionId">): RumEvent {
  return {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
    friendCode: event.friendCode ?? currentFriendCode,
    sessionId: getSessionId(),
    routeTemplate: event.routeTemplate || currentRoute,
  };
}

function installFetchObserver(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = performance.now();
    try {
      const response = await originalFetch(input, init);
      recordFetchRum(input, init, performance.now() - startedAt, response.status);
      return response;
    } catch (err) {
      recordFetchRum(input, init, performance.now() - startedAt, 0, err);
      throw err;
    }
  };
}

function recordFetchRum(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  durationMs: number,
  statusCode: number,
  err?: unknown,
): void {
  const url = typeof input === "string" ? input : input.toString();
  if (!url.includes("/api/") || url.includes("/observability/")) {
    return;
  }
  recordRumEvent({
    routeTemplate: currentRoute,
    apiWaitMs: durationMs,
    jsError: Boolean(err),
    errorName: err instanceof Error ? err.name : "",
    errorMessageHash: err instanceof Error ? hashString(err.message) : "",
    attrs: {
      apiRoute: normalizeApiPath(url),
      method: init?.method ?? "GET",
      statusCode,
    },
  });
}

function installErrorObservers(): void {
  window.addEventListener("error", (event) => {
    recordRumEvent({
      routeTemplate: currentRoute,
      jsError: true,
      errorName: event.error?.name || "Error",
      errorMessageHash: hashString(event.message || ""),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    recordRumEvent({
      routeTemplate: currentRoute,
      jsError: true,
      errorName: reason instanceof Error ? reason.name : "UnhandledRejection",
      errorMessageHash: hashString(
        reason instanceof Error ? reason.message : String(reason),
      ),
    });
  });
}

function installWebVitalObservers(): void {
  if (!("PerformanceObserver" in window)) {
    return;
  }
  observePerformance("paint", (entry) => {
    if (entry.name === "first-contentful-paint") {
      recordRumEvent({ routeTemplate: currentRoute, fcpMs: entry.startTime });
    }
  });
  observePerformance("largest-contentful-paint", (entry) => {
    recordRumEvent({ routeTemplate: currentRoute, lcpMs: entry.startTime });
  });
  let cls = 0;
  observePerformance("layout-shift", (entry) => {
    const layoutShift = entry as PerformanceEntry & {
      value?: number;
      hadRecentInput?: boolean;
    };
    if (!layoutShift.hadRecentInput) {
      cls += layoutShift.value ?? 0;
      recordRumEvent({ routeTemplate: currentRoute, cls });
    }
  });
}

function observePerformance(
  type: string,
  callback: (entry: PerformanceEntry) => void,
): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        callback(entry);
      }
    });
    observer.observe({ type, buffered: true });
  } catch {
    // Unsupported browser or entry type.
  }
}

function getSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) {
      return existing;
    }
    const next = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, next);
    return next;
  } catch {
    return "unknown";
  }
}

function getNavigationLoadMs(): number {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return nav ? Math.max(0, nav.loadEventEnd - nav.startTime) : 0;
}

function getNavigationTtfbMs(): number {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return nav ? Math.max(0, nav.responseStart - nav.requestStart) : 0;
}

function normalizeApiPath(url: string): string {
  const pathname = toPathname(url);
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\b\d{9,}\b/g, ":id");
}

function toPathname(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function getBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) {return "edge";}
  if (ua.includes("Chrome/")) {return "chrome";}
  if (ua.includes("Firefox/")) {return "firefox";}
  if (ua.includes("Safari/")) {return "safari";}
  return "other";
}

function getOs(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) {return "windows";}
  if (ua.includes("Android")) {return "android";}
  if (ua.includes("iPhone") || ua.includes("iPad")) {return "ios";}
  if (ua.includes("Mac OS")) {return "macos";}
  if (ua.includes("Linux")) {return "linux";}
  return "other";
}

function getDeviceType(): string {
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
    ? "mobile"
    : "desktop";
}

function getAppVersion(): string {
  return String(import.meta.env.VITE_APP_VERSION || "");
}
