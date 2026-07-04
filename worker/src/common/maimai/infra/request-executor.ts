import { CookieJar } from "tough-cookie";

import { TIMEOUTS } from "../constants.ts";
import {
  CookieExpiredError,
  MaimaiRateLimitedError,
  NonRetryableError,
} from "./errors.ts";
import {
  assertMaimaiPageResponse,
  buildMaimaiRequestPlan,
  createTimeoutError,
  getRetryDelayMs,
  isTimeoutError,
  type MaimaiPageRequest,
  type MaimaiPageResponse,
} from "./request-policy.ts";
import config from "../../config.ts";
import { createDxnetSession } from "./dxnet-session.ts";
import { requestRuntime } from "./request-runtime.ts";

export interface ExecuteMaimaiPageRequestOptions {
  cookieJar: CookieJar;
  request: MaimaiPageRequest;
  onCookieExpired?: () => void;
  onCookieChanged?: () => void;
}

export async function executeMaimaiPageRequest({
  cookieJar,
  request,
  onCookieExpired,
  onCookieChanged,
}: ExecuteMaimaiPageRequestOptions): Promise<MaimaiPageResponse> {
  const dxnetSession = createDxnetSession(cookieJar, { onCookieChanged });
  const requestPlan = buildMaimaiRequestPlan(request, {
    defaultTimeoutMs: config.fetchTimeOut ?? TIMEOUTS.default,
    getToken: () => dxnetSession.getToken(),
  });
  const requestContext = requestRuntime.getContext();
  const requestPriority = requestRuntime.getPriority(requestContext);
  let rateLimitCount = 0;

  for (let i = 0; i < requestPlan.retryCount; i++) {
    let logStatusCode = 0;
    let logResponseBody: string | null = null;
    let logErrorClass = "";
    let requestStartedAt = 0;

    try {
      await requestRuntime.waitForSlot(requestPriority);

      requestStartedAt = Date.now();
      const response = await dxnetSession.runExclusive(
        () =>
          dxnetSession.send(requestPlan.url, {
            ...requestPlan.init,
            signal: AbortSignal.timeout(requestPlan.timeoutMs),
          }) as Promise<Response>,
      );

      const page = {
        url: requestPlan.url,
        finalUrl: response.url,
        status: response.status,
        body: await response.clone().text(),
        response,
      };
      logStatusCode = page.status;
      logResponseBody = page.body;

      await assertMaimaiPageResponse({
        page,
        request: requestPlan,
      });

      requestRuntime.resetFreezeBackoff();
      return page;
    } catch (e: unknown) {
      logErrorClass = getRequestErrorClass(e, logStatusCode);

      if (e instanceof MaimaiRateLimitedError) {
        rateLimitCount++;
        console.log(
          `[MaimaiClient] 限流 (567) ${requestPlan.url}, 限流重试 ${rateLimitCount}/${requestPlan.rateLimitRetryCount}`,
        );

        if (rateLimitCount >= requestPlan.rateLimitRetryCount) {
          throw new Error(
            `请求被限流 (HTTP 567)，已重试 ${rateLimitCount} 次仍未成功`,
          );
        }

        requestRuntime.freeze();
        i--;
        continue;
      }

      if (e instanceof CookieExpiredError) {
        onCookieExpired?.();
        throw e;
      }
      if (e instanceof NonRetryableError) {
        throw e;
      }

      const error = e as Error;
      console.log(
        `Delay due to fetch failed with attempt ${requestPlan.url} #${
          i + 1
        }, error: ${error}`,
      );

      if (i === requestPlan.retryCount - 1) {
        if (isTimeoutError(error)) {
          throw createTimeoutError(requestPlan.timeoutMs);
        }
        throw e;
      }

      const delay = getRetryDelayMs(i);
      console.log(
        `Retrying in ${delay}ms (attempt ${i + 1}/${requestPlan.retryCount})...`,
      );
      await requestRuntime.sleep(delay);
    } finally {
      if (requestContext.onRequestLog) {
        try {
          requestContext.onRequestLog({
            url: requestPlan.url,
            method: requestPlan.init.method?.toString() ?? "GET",
            statusCode: logStatusCode,
            durationMs: requestStartedAt ? Date.now() - requestStartedAt : 0,
            bodySize:
              typeof logResponseBody === "string"
                ? Buffer.byteLength(logResponseBody)
                : null,
            errorClass: logErrorClass,
          });
        } catch {
          // Best-effort logging; don't impact main request flow
        }
      }
    }
  }

  throw new Error("Unreachable");
}

function getRequestErrorClass(error: unknown, statusCode: number): string {
  if (statusCode === 567 || error instanceof MaimaiRateLimitedError) {
    return "rate_limit_567";
  }
  if (error instanceof CookieExpiredError) {
    return "cookie_expired";
  }
  if (error instanceof NonRetryableError) {
    return "non_retryable";
  }
  if (error instanceof Error && isTimeoutError(error)) {
    return "timeout";
  }
  if (error) {
    return "maimai_request_error";
  }
  if (statusCode >= 400) {
    return "http_error";
  }
  return "";
}
