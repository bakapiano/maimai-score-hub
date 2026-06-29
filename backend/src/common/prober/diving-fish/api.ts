/**
 * Diving-Fish (水鱼查分器) API 客户端
 *
 * 国服晚上 16:00-22:00 BJT 经常 5xx，单次宕机 1-3 分钟。所有调用都包
 * 同款指数退避 retry，但分两套：
 *   - 用户交互路径 (login / getProfile / refreshImportToken)：跨度
 *     ~10s（用户在前端等着，太长会卡 UI），救得了瞬时抖动
 *   - 后台导出 (uploadRecords)：跨度 ~315s（异步跑，能跨过整个宕机窗口）
 * 5xx + 网络错误 retry，4xx 立即抛（4xx 通常是 token 失效 / 输入错，
 * retry 救不了）。
 */

import { observeFetch } from '../../observability/external-call-recorder';

const BASE_URL = 'https://www.diving-fish.com/api/maimaidxprober';

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.diving-fish.com',
  Referer: 'https://www.diving-fish.com/maimaidx/prober/',
};

/** Short backoff for user-facing requests (~10s total). */
const SHORT_BACKOFF_MS = [0, 1_000, 3_000, 6_000];
/** Long backoff for background exports (~315s total). */
const LONG_BACKOFF_MS = [0, 15_000, 60_000, 240_000];

/**
 * Fetch with exponential backoff for 5xx + network errors.
 * Returns the Response object as-is on success (caller handles the body);
 * throws on 4xx immediately (no retry); throws after exhausting retries
 * for 5xx / network errors.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  errorContext: string,
  backoff: readonly number[] = SHORT_BACKOFF_MS,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < backoff.length; attempt++) {
    if (backoff[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoff[attempt]));
    }
    let res: Response;
    try {
      res = await observeFetch(
        {
          target: 'diving_fish',
          apiGroup: 'prober',
          method: init.method?.toString() ?? 'GET',
          urlGroup: classifyDivingFishUrl(url),
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(url, init),
      );
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (res.ok) {
      return res;
    }
    if (res.status >= 400 && res.status < 500) {
      // 4xx: don't retry, but include body in error
      const text = await res.text().catch(() => '');
      throw new Error(
        `${errorContext} (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    // 5xx: stash and retry
    const text = await res.text().catch(() => '');
    lastErr = new Error(
      `${errorContext} (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${errorContext} failed after retries`);
}

export type DivingFishProfile = {
  import_token?: string;
  nickname?: string;
  username?: string;
};

export type DivingFishLoginResult = {
  jwtToken: string;
};

/**
 * 使用用户名和密码登录水鱼，获取 JWT token
 */
export async function login(
  username: string,
  password: string,
): Promise<DivingFishLoginResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/login`,
    {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    },
    '水鱼登录失败',
  );

  // Extract jwt_token from Set-Cookie header
  const setCookieHeader = res.headers.get('set-cookie');
  const jwtTokenMatch = setCookieHeader?.match(/jwt_token=([^;]+)/);
  if (!jwtTokenMatch) {
    throw new Error('无法获取登录凭证');
  }

  return { jwtToken: jwtTokenMatch[1] };
}

/**
 * 获取用户 profile（需要 JWT token）
 */
export async function getProfile(jwtToken: string): Promise<DivingFishProfile> {
  const res = await fetchWithRetry(
    `${BASE_URL}/player/profile`,
    {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        Cookie: `jwt_token=${jwtToken}`,
      },
    },
    '获取用户信息失败',
  );
  return res.json() as Promise<DivingFishProfile>;
}

/**
 * 刷新/生成新的 import token（需要 JWT token）
 * 注意：这会覆盖原有的 import token
 */
export async function refreshImportToken(jwtToken: string): Promise<void> {
  await fetchWithRetry(
    `${BASE_URL}/player/import_token`,
    {
      method: 'PUT',
      headers: {
        ...DEFAULT_HEADERS,
        Cookie: `jwt_token=${jwtToken}`,
      },
    },
    '刷新 import token 失败',
  );
}

/**
 * 通过用户名和密码获取 import token
 * 如果用户已有 import token 则直接返回，否则生成新的
 */
export async function getImportToken(
  username: string,
  password: string,
): Promise<{ importToken: string; nickname?: string }> {
  // Step 1: Login
  const { jwtToken } = await login(username, password);

  // Step 2: Get profile to check if import_token exists
  const profile = await getProfile(jwtToken);

  // Step 3: If no import_token, create one
  if (!profile.import_token) {
    await refreshImportToken(jwtToken);
    // Get profile again to retrieve the new token
    const updatedProfile = await getProfile(jwtToken);
    if (!updatedProfile.import_token) {
      throw new Error('无法获取 import token');
    }
    return {
      importToken: updatedProfile.import_token,
      nickname: updatedProfile.nickname,
    };
  }

  return {
    importToken: profile.import_token,
    nickname: profile.nickname,
  };
}

export type DivingFishRecord = {
  achievements: number | null;
  dxScore: number | null;
  fc: string | null;
  fs: string | null;
  level_index: number;
  title: string;
  type: 'SD' | 'DX';
};

export type UploadRecordsResponse = {
  status: number;
  data: unknown;
};

/**
 * 上传成绩记录到水鱼查分器（异步后台路径，使用 LONG_BACKOFF 跨度
 * ~315s，能跨过水鱼整个宕机窗口）。
 *
 * 特判：500 + html body（默认 nginx 错误页）实际上 upsert 是成功的
 * — 水鱼后端写入 DB 后渲染响应时挂掉 → 返回 500 但成绩已经入库。
 * 重试反而会污染（虽然 upsert 幂等，但浪费 1 次请求）。所以把
 * "500 + html" 当 success 返回。
 */
export async function uploadRecords(
  records: DivingFishRecord[],
  importToken: string,
): Promise<UploadRecordsResponse> {
  const treatAsSuccess = (status: number, body: string): boolean => {
    // diving-fish 500 with default flask html error page actually means
    // "DB write succeeded, response render failed". Trigger off the
    // "500 Internal Server Error" html signature.
    return (
      status === 500 &&
      /500 Internal Server Error/i.test(body) &&
      /<!doctype html/i.test(body)
    );
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < LONG_BACKOFF_MS.length; attempt++) {
    if (LONG_BACKOFF_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, LONG_BACKOFF_MS[attempt]));
    }
    let res: Response;
    try {
      res = await observeFetch(
        {
          target: 'diving_fish',
          apiGroup: 'prober_export',
          method: 'POST',
          urlGroup: 'diving_fish.update_records',
          statusCode: 0,
          durationMs: 0,
          bodySize: JSON.stringify(records).length,
          attrs: { records: records.length },
        },
        () =>
          fetch(`${BASE_URL}/player/update_records`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Import-Token': importToken,
            },
            body: JSON.stringify(records),
          }),
      );
    } catch (err) {
      lastErr = err;
      continue;
    }

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.ok) {
      return { status: res.status, data };
    }
    // Diving-fish quirk: write succeeds but response rendering 500s.
    // Treat as success — upsert is idempotent so even if we're wrong,
    // a follow-up retry next sweep would heal.
    if (treatAsSuccess(res.status, text)) {
      return {
        status: 200,
        data: { degraded: true, originalStatus: 500, data },
      };
    }
    if (res.status >= 400 && res.status < 500) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(
        `Diving-fish responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
    // 5xx without the success-signature → retry
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    lastErr = new Error(
      `Diving-fish responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Diving-fish upload failed after retries');
}

function classifyDivingFishUrl(url: string): string {
  if (url.includes('/login')) {
    return 'diving_fish.login';
  }
  if (url.includes('/player/profile')) {
    return 'diving_fish.profile';
  }
  if (url.includes('/player/import_token')) {
    return 'diving_fish.import_token';
  }
  if (url.includes('/music_data')) {
    return 'diving_fish.music_data';
  }
  return 'diving_fish.other';
}
