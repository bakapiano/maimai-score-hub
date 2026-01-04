import { mkdir, writeFile } from "node:fs/promises";

import { CookieJar } from "tough-cookie";
import config from "./config.ts";
import { join } from "node:path";
import makeFetchCookie from "fetch-cookie";

const COOKIE_EXPIRE_LOCATIONS = new Set([
  "https://maimai.wahlap.com/maimai-mobile/error/",
  "https://maimai.wahlap.com/maimai-mobile/logout/",
]);

const COOKIE_EXPIRE_DUMP_DIR =
  process.env.COOKIE_EXPIRE_DUMP_DIR ||
  join(process.cwd(), "log", "cookie-expire");

const COOKIE_EXPIRE_LINE_1 =
  '<div class="p_5 f_12 gray break">连接时间已过期。<br>请于稍后重新尝试。</div>';
const COOKIE_EXPIRE_LINE_2 = '<div class="p_5 f_12 gray break">再见！</div>';

async function dumpCookieExpireResponse(body: string) {
  try {
    await mkdir(COOKIE_EXPIRE_DUMP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(COOKIE_EXPIRE_DUMP_DIR, `cookie-expire-${ts}.html`);
    await writeFile(file, body, "utf8");
  } catch (err) {
    console.warn("Failed to dump cookie expire response", err);
  }
}

function extractContainerRedMessage(body: string): string | null {
  const match = body.match(
    /<div\s+class="container_red p_10"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (!match) return null;
  const innerHtml = match[1];
  const text = innerHtml.replace(/<[^>]*>/g, "").trim();
  return text || null;
}

export class CookieExpiredError extends Error {
  constructor(message = "Cookie 已失效") {
    super(message);
    this.name = "CookieExpiredError";
  }
}

async function fetchWithCookieWithRetry(
  cj: CookieJar,
  url: string,
  options: any | undefined = undefined,
  fetchTimeout: number | undefined = undefined,
  throwOnCookieExpire = false
) {
  const fetch = makeFetchCookie(global.fetch, cj);
  for (let i = 0; i < config.fetchRetryCount; i++) {
    try {
      const result = await fetch(url, {
        signal: (AbortSignal as any).timeout(
          fetchTimeout || config.fetchTimeOut
        ),
        ...options,
      });
      if (throwOnCookieExpire) {
        const location = result.url;
        const clone = result.clone();
        const body = await clone.text();

        const isCookieExpireBody =
          body.includes(COOKIE_EXPIRE_LINE_1) &&
          body.includes(COOKIE_EXPIRE_LINE_2);

        if (COOKIE_EXPIRE_LOCATIONS.has(location) && isCookieExpireBody) {
          // await dumpCookieExpireResponse(body);
          throw new CookieExpiredError();
        }

        const containerMsg = extractContainerRedMessage(body);
        if (containerMsg) {
          throw new Error(containerMsg);
        }
      }
      return result;
    } catch (e: any) {
      if (e instanceof CookieExpiredError) {
        throw e;
      }
      console.log(
        `Delay due to fetch failed with attempt ${url} #${i + 1}, error: ${e}`
      );
      if (i === config.fetchRetryCount - 1) {
        if (e.name === "AbortError" || e.name === "TimeoutError")
          throw new Error(
            `请求超时, 超时时间: ${
              fetchTimeout || config.fetchTimeOut / 1000.0
            } 秒`
          );
        else throw e;
      } else await sleep(1000);
    }
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { fetchWithCookieWithRetry, sleep };
