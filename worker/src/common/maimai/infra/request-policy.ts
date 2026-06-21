import {
  COOKIE_EXPIRE_LOCATIONS,
  COOKIE_EXPIRE_MARKERS,
  DEFAULT_HEADERS,
  RETRY,
} from "../constants.ts";
import {
  CookieExpiredError,
  MaimaiRateLimitedError,
  extractContainerRedMessage,
} from "./errors.ts";

export interface MaimaiPageRequest {
  url: string;
  formBodyWithToken?: string;
  policy?: {
    timeoutMs?: number;
    assertBody?: (body: string) => void;
  };
}

export interface MaimaiPageResponse {
  url: string;
  finalUrl: string;
  status: number;
  body: string;
  response: Response;
}

export interface MaimaiRequestPlan {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  retryCount: number;
  rateLimitRetryCount: number;
  assertBody?: (body: string) => void;
}

export function buildMaimaiRequestPlan(
  request: MaimaiPageRequest,
  env: {
    defaultTimeoutMs: number;
    getToken(): string | undefined;
  },
): MaimaiRequestPlan {
  const hasTokenForm = request.formBodyWithToken !== undefined;
  const headers = {
    ...DEFAULT_HEADERS,
    ...(hasTokenForm
      ? { "content-type": "application/x-www-form-urlencoded" }
      : {}),
  };
  const body = hasTokenForm
    ? appendFormToken(request.formBodyWithToken, env.getToken())
    : undefined;

  return {
    url: request.url,
    init: {
      ...(hasTokenForm ? { method: "POST" } : {}),
      headers,
      ...(body !== undefined ? { body } : {}),
    },
    timeoutMs: request.policy?.timeoutMs ?? env.defaultTimeoutMs,
    retryCount: RETRY.defaultCount,
    rateLimitRetryCount: RETRY.rateLimitMaxCount,
    assertBody: request.policy?.assertBody,
  };
}

export async function assertMaimaiPageResponse(params: {
  page: MaimaiPageResponse;
  request: MaimaiRequestPlan;
}): Promise<void> {
  const { page, request } = params;
  const location = page.finalUrl;
  const body = page.body;

  const isCookieExpireBody =
    body.includes(COOKIE_EXPIRE_MARKERS.line1) ||
    body.includes(COOKIE_EXPIRE_MARKERS.line2) ||
    body.includes(COOKIE_EXPIRE_MARKERS.errorCode100001) ||
    body.includes(COOKIE_EXPIRE_MARKERS.errorCode200002);

  if (COOKIE_EXPIRE_LOCATIONS.has(location as any) && isCookieExpireBody) {
    const markers = [
      body.includes(COOKIE_EXPIRE_MARKERS.line1) ? "line1" : "",
      body.includes(COOKIE_EXPIRE_MARKERS.line2) ? "line2" : "",
      body.includes(COOKIE_EXPIRE_MARKERS.errorCode100001) ? "100001" : "",
      body.includes(COOKIE_EXPIRE_MARKERS.errorCode200002) ? "200002" : "",
    ]
      .filter(Boolean)
      .join(",");

    console.log(
      `[MaimaiClient] CookieExpired detail url=${page.url} status=${page.status} location=${location} markers=[${markers}] bodyLen=${body.length} bodyHead=${JSON.stringify(body.slice(0, 400))}`,
    );
    throw new CookieExpiredError();
  }

  if (page.status === 401 || page.status === 403) {
    console.log(
      `[MaimaiClient] CookieExpired (HTTP ${page.status}) url=${page.url} location=${location} bodyHead=${JSON.stringify(body.slice(0, 400))}`,
    );
    throw new CookieExpiredError(`Cookie 已失效 (HTTP ${page.status})`);
  }

  if (page.status === 567) {
    throw new MaimaiRateLimitedError();
  }

  if (!page.response.ok) {
    throw new Error(
      `请求失败 (HTTP ${page.status}): ${body.slice(0, 500)}`,
    );
  }

  const containerMsg = extractContainerRedMessage(body);
  if (containerMsg) {
    throw new Error(containerMsg);
  }

  request.assertBody?.(body);
}

export function getRetryDelayMs(attemptIndex: number): number {
  const baseDelay = Math.min(
    RETRY.baseDelayMs * Math.pow(2, attemptIndex),
    RETRY.maxDelayMs,
  );
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.round(baseDelay + jitter);
}

export function isTimeoutError(error: Error): boolean {
  return error.name === "AbortError" || error.name === "TimeoutError";
}

export function createTimeoutError(timeoutMs: number): Error {
  return new Error(`请求超时, 超时时间: ${timeoutMs / 1000.0} 秒`);
}

function appendFormToken(body: string | undefined, token: string | undefined): string {
  if (!body) {
    return `token=${token ?? ""}`;
  }
  return `${body}&token=${token ?? ""}`;
}
