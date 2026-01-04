import { BadRequestException } from '@nestjs/common';
import type { LxnsScore } from './converter';

const LXNS_ENDPOINT =
  'https://maimai.lxns.net/api/v0/user/maimai/player/scores';

type UploadResponse = {
  status: number;
  response: unknown;
  exported: number;
};

export async function uploadLxnsScores(
  scores: LxnsScore[],
  token: string,
): Promise<UploadResponse> {
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

  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new BadRequestException(
      `LXNS responded ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  return {
    status: res.status,
    response: data,
    exported: scores.length,
  };
}