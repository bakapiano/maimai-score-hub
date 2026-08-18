/**
 * 舞萌成绩抓取相关页面 API。
 */

import {
  getCachedFriendVsSongs,
  setCachedFriendVsSongs,
} from "../backend/temp-cache.ts";
import { FRIEND_VS_GENRES, MAIMAI_URLS, RETRY, TIMEOUTS } from "./constants.ts";
import type { FriendVsSong } from "../types.ts";
import {
  CookieExpiredError,
  MaimaiRateLimitedError,
  NonRetryableError,
} from "./infra/errors.ts";
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
    let songs: FriendVsSong[];
    try {
      songs = await this.fetchFriendVsPage(friendCode, scoreType, diff, side);
    } catch (error) {
      if (!shouldFallbackToGenres(error, diff)) {
        throw error;
      }
      console.warn(
        `[MaimaiClient] Friend VS full page failed; falling back to genres friendCode=${friendCode} scoreType=${scoreType} diff=${diff} side=${side ?? "all"} error=${errorMessage(error)}`,
      );
      songs = await this.fetchFriendVsGenres(friendCode, scoreType, diff, side);
    }
    const cost = Date.now() - startTime;
    console.log(
      `[MaimaiClient] getFriendVS friendCode=${friendCode} scoreType=${scoreType} diff=${diff} side=${side ?? "all"} songs=${songs.length} cost=${cost}ms`,
    );

    if (options.jobId) {
      await setCachedFriendVsSongs(options.jobId, diff, cacheType, songs);
    }

    return songs;
  }

  async getFriendVsGenre(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
    genre: number,
    options: FriendVsOptions = {},
  ): Promise<FriendVsSong[]> {
    return this.getPlannedPage(
      MAIMAI_URLS.friendVS(friendCode, scoreType, diff, undefined, genre),
      scoreType,
      100_000 + diff * 1_000 + genre,
      `genre diff=${diff} genre=${genre}`,
      options,
    );
  }

  async getFriendVsLevel(
    friendCode: string,
    scoreType: 1 | 2,
    level: number,
    options: FriendVsOptions = {},
  ): Promise<FriendVsSong[]> {
    return this.getPlannedPage(
      MAIMAI_URLS.friendLevelVS(friendCode, scoreType, level),
      scoreType,
      200_000 + level,
      `level=${level}`,
      options,
    );
  }

  private async getPlannedPage(
    url: string,
    scoreType: 1 | 2,
    cachePageId: number,
    description: string,
    options: FriendVsOptions,
  ): Promise<FriendVsSong[]> {
    if (options.jobId) {
      const cached = await getCachedFriendVsSongs(
        options.jobId,
        cachePageId,
        scoreType,
      );
      if (cached) return cached;
    }
    const startedAt = Date.now();
    const songs = await this.fetchFriendVsUrl(url);
    console.log(
      `[MaimaiClient] targeted Friend VS ${description} scoreType=${scoreType} songs=${songs.length} cost=${Date.now() - startedAt}ms`,
    );
    if (options.jobId) {
      await setCachedFriendVsSongs(
        options.jobId,
        cachePageId,
        scoreType,
        songs,
      );
    }
    return songs;
  }

  private async fetchFriendVsGenres(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
    side?: "win" | "lose",
  ): Promise<FriendVsSong[]> {
    const songs: FriendVsSong[] = [];
    for (const genre of FRIEND_VS_GENRES) {
      const genreSongs = await this.fetchFriendVsPage(
        friendCode,
        scoreType,
        diff,
        side,
        genre,
      );
      songs.push(...genreSongs);
      console.log(
        `[MaimaiClient] Friend VS genre fallback friendCode=${friendCode} scoreType=${scoreType} diff=${diff} side=${side ?? "all"} genre=${genre} songs=${genreSongs.length}`,
      );
    }
    return songs;
  }

  private async fetchFriendVsPage(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
    side?: "win" | "lose",
    genre = 99,
  ): Promise<FriendVsSong[]> {
    const url = MAIMAI_URLS.friendVS(friendCode, scoreType, diff, side, genre);
    return this.fetchFriendVsUrl(url);
  }

  private async fetchFriendVsUrl(url: string): Promise<FriendVsSong[]> {
    const result = await this.http.requestPage({
      url,
      policy: {
        timeoutMs: TIMEOUTS.friendVS,
        retryCount: RETRY.friendVSCount,
        assertBody: (body) => {
          if (!body.includes('<div class="friend_vs_block">')) {
            throw new NonRetryableError(
              "获取 Friend VS 页面失败：页面不包含 friend_vs_block，可能是好友没有添加成功",
            );
          }
        },
      },
    });
    return parseFriendVsSongs(result.body);
  }
}

function shouldFallbackToGenres(error: unknown, diff: number): boolean {
  if (
    diff === 10 ||
    error instanceof CookieExpiredError ||
    error instanceof MaimaiRateLimitedError ||
    error instanceof NonRetryableError
  ) {
    return false;
  }

  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) {
      const message = current.message.toLowerCase();
      if (
        current.name === "AbortError" ||
        current.name === "TimeoutError" ||
        message.includes("terminated") ||
        message.includes("econnreset") ||
        message.includes("请求超时") ||
        message.includes("timed out")
      ) {
        return true;
      }
    }
    if (typeof current === "object") {
      const record = current as { cause?: unknown; code?: unknown };
      if (
        record.code === "ECONNRESET" ||
        record.code === "ETIMEDOUT" ||
        record.code === "UND_ERR_SOCKET"
      ) {
        return true;
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getFriendVsCacheType(scoreType: 1 | 2, side?: "win" | "lose"): number {
  if (!side) {
    return scoreType;
  }
  return scoreType * 10 + (side === "win" ? 1 : 2);
}
