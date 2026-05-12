import { BadRequestException } from '@nestjs/common';
import type { LxnsScore } from './converter';

const LXNS_ENDPOINT =
  'https://maimai.lxns.net/api/v0/user/maimai/player/scores';

type UploadResponse = {
  status: number;
  response: unknown;
  exported: number;
};

/**
 * 上传成绩到 LXNS。和 diving-fish 一样加指数退避 retry：
 * 网络错误 / 5xx 退避序列 0 → 15s → 60s → 240s（共 ~315s 跨度），4xx 立即抛。
 */
export async function uploadLxnsScores(
  scores: LxnsScore[],
  token: string,
): Promise<UploadResponse> {
  const backoffMs = [0, 15_000, 60_000, 240_000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
    let result: { ok: boolean; status: number; data: unknown };
    try {
      const res = await fetch(LXNS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Token': token,
        },
        body: JSON.stringify({ scores }),
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      result = { ok: res.ok, status: res.status, data };
    } catch (err) {
      lastErr = err;
      continue;
    }

    if (result.ok) {
      return {
        status: result.status,
        response: result.data,
        exported: scores.length,
      };
    }
    const detail =
      typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    const err = new BadRequestException(
      `LXNS responded ${result.status}${detail ? `: ${detail}` : ''}`,
    );
    if (result.status >= 400 && result.status < 500) {
      throw err;
    }
    lastErr = err;
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('LXNS upload failed after retries');
}
