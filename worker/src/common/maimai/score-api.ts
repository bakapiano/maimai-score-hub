/**
 * 舞萌成绩抓取相关页面 API。
 */

import {
  getCachedFriendVsSongs,
  setCachedFriendVsSongs,
} from "../backend/temp-cache.ts";
import { MAIMAI_URLS, TIMEOUTS } from "./constants.ts";
import type { FriendVsSong } from "../types.ts";
import { NonRetryableError } from "./infra/errors.ts";
import type { MaimaiHttpClient } from "./infra/http-client.ts";
import { parseFriendVsSongs } from "./parsers/friend-vs-parser.ts";

type FriendVsOptions = {
  jobId?: string;
};

export class MaimaiScoreApi {
  private readonly http: MaimaiHttpClient;

  constructor(http: MaimaiHttpClient) {
    this.http = http;
  }

  /**
   * 获取并解析 Friend VS 页面。
   *
   * `side`:
   *   undefined - default page (only songs that fit on the default
   *               cap; can miss songs in either direction)
   *   "win"     - only songs where the bot beats the friend
   *   "lose"    - only songs where the friend beats the bot
   *
   * For complete coverage we call this twice (win + lose) and merge.
   */
  async getFriendVS(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
    side?: "win" | "lose",
    options: FriendVsOptions = {},
  ): Promise<FriendVsSong[]> {
    const cacheType = getFriendVsCacheType(scoreType, side);
    if (options.jobId) {
      const cached = await getCachedFriendVsSongs(
        options.jobId,
        diff,
        cacheType,
      );
      if (cached) {
        return cached;
      }
    }

    const startTime = Date.now();
    const url = MAIMAI_URLS.friendVS(friendCode, scoreType, diff, side);
    const result = await this.http.requestPage({
      url,
      policy: {
        timeoutMs: TIMEOUTS.friendVS,
        assertBody: (body) => {
          if (!body.includes('<div class="friend_vs_block">')) {
            throw new NonRetryableError(
              "获取 Friend VS 页面失败：页面不包含 friend_vs_block，可能是好友没有添加成功",
            );
          }
        },
      },
    });
    const text = result.body;
    const songs = parseFriendVsSongs(text);
    const cost = Date.now() - startTime;
    console.log(
      `[MaimaiClient] getFriendVS friendCode=${friendCode} scoreType=${scoreType} diff=${diff} side=${side ?? "all"} songs=${songs.length} cost=${cost}ms`,
    );

    if (options.jobId) {
      await setCachedFriendVsSongs(
        options.jobId,
        diff,
        cacheType,
        songs,
      );
    }

    return songs;
  }
}

function getFriendVsCacheType(
  scoreType: 1 | 2,
  side?: "win" | "lose",
): number {
  if (!side) {
    return scoreType;
  }
  return scoreType * 10 + (side === "win" ? 1 : 2);
}
