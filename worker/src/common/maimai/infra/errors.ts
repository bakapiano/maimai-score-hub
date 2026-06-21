/**
 * Cookie 已过期错误
 */
export class CookieExpiredError extends Error {
  constructor(message = "Cookie 已失效") {
    super(message);
    this.name = "CookieExpiredError";
  }
}

/**
 * Permanent failure inside a response assertion — should bypass retry.
 * Use for cases where retrying makes no sense, e.g. friend has not been
 * added on the cabinet so the friend_vs page will never render.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * DXNet rate limit response. The executor handles this separately from normal
 * transient failures because it must freeze the global request queue first.
 */
export class MaimaiRateLimitedError extends Error {
  constructor(message = "请求被限流 (HTTP 567)") {
    super(message);
    this.name = "MaimaiRateLimitedError";
  }
}

/**
 * 从 HTML 中提取 container_red 错误信息
 */
export function extractContainerRedMessage(body: string): string | null {
  const match = body.match(
    /<div\s+class="container_red[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<footer|$)/i,
  );
  if (!match) return null;
  const innerHtml = match[1];
  const text = innerHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
