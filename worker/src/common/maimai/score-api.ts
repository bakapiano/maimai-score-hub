/**
 * 舞萌成绩抓取相关页面 API。
 */

import {
  getCachedFriendVsSongs,
  setCachedFriendVsSongs,
} from "../backend/temp-cache.ts";
import {
  FRIEND_VS_GENRES,
  MAIMAI_URLS,
  RETRY,
  TIMEOUTS,
  type FriendVsSide,
} from "./constants.ts";
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

/**
 * These are already secondary pages after the full-diff request failed. Their
 * measured all-page bodies are the two largest genre fallbacks (genre 102:
 * 319 rows / 579,154 B; genre 105: 384 rows / 692,767 B). During DX NET peak
 * traffic, large response bodies frequently end mid-stream as
 * `TypeError: terminated` / ECONNRESET, so go straight to win/lose/tie instead
 * of risking another oversized all-page request.
 */
const SIDE_SPLIT_GENRES = new Set([102, 105]);

/**
 * Level 12+, 13, and 13+ are the largest planned level pages (360–473 rows,
 * 647,890–852,893 B measured). Keep the one-request fast path, but the first
 * terminated/timeout immediately switches to smaller side partitions; waiting
 * for the same large request to exhaust retries performs poorly at peak time.
 */
const SIDE_SPLIT_LEVELS = new Set([18, 19, 20]);
const COMPLETE_FRIEND_VS_SIDES = ["win", "lose", "tie"] as const;

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
   *   "tie"     - only songs where both scores are equal
   *
   * Complete coverage is win + lose + tie.
   */
  async getFriendVS(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
    side?: FriendVsSide,
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
      () =>
        this.fetchFriendVsUrl(
          MAIMAI_URLS.friendVS(friendCode, scoreType, diff, undefined, genre),
        ),
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
      () => this.fetchFriendVsLevelPage(friendCode, scoreType, level),
      scoreType,
      200_000 + level,
      `level=${level}`,
      options,
    );
  }

  private async getPlannedPage(
    fetchPage: () => Promise<FriendVsSong[]>,
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
    const songs = await fetchPage();
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
    side?: FriendVsSide,
  ): Promise<FriendVsSong[]> {
    const songs: FriendVsSong[] = [];
    for (const genre of FRIEND_VS_GENRES) {
      const genreSongs =
        side === undefined && SIDE_SPLIT_GENRES.has(genre)
          ? await this.fetchFriendVsSideSplit(
              (partition) =>
                MAIMAI_URLS.friendVS(
                  friendCode,
                  scoreType,
                  diff,
                  partition,
                  genre,
                ),
              `genre diff=${diff} genre=${genre}`,
            )
          : await this.fetchFriendVsPage(
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
    side?: FriendVsSide,
    genre = 99,
  ): Promise<FriendVsSong[]> {
    const url = MAIMAI_URLS.friendVS(friendCode, scoreType, diff, side, genre);
    return this.fetchFriendVsUrl(url);
  }

  private async fetchFriendVsLevelPage(
    friendCode: string,
    scoreType: 1 | 2,
    level: number,
  ): Promise<FriendVsSong[]> {
    const url = MAIMAI_URLS.friendLevelVS(friendCode, scoreType, level);
    if (!SIDE_SPLIT_LEVELS.has(level)) {
      return this.fetchFriendVsUrl(url);
    }
    try {
      return await this.fetchFriendVsUrl(url, 1);
    } catch (error) {
      if (!isFriendVsTransportFallbackError(error)) throw error;
      console.warn(
        `[MaimaiClient] Friend VS level page failed; falling back to side partitions friendCode=${friendCode} scoreType=${scoreType} level=${level} error=${errorMessage(error)}`,
      );
      return this.fetchFriendVsSideSplit(
        (side) => MAIMAI_URLS.friendLevelVS(friendCode, scoreType, level, side),
        `level=${level}`,
      );
    }
  }

  private async fetchFriendVsSideSplit(
    urlForSide: (side: FriendVsSide) => string,
    description: string,
  ): Promise<FriendVsSong[]> {
    const songs: FriendVsSong[] = [];
    for (const side of COMPLETE_FRIEND_VS_SIDES) {
      const partitionSongs = await this.fetchFriendVsUrl(urlForSide(side));
      songs.push(...partitionSongs);
      console.log(
        `[MaimaiClient] Friend VS side partition ${description} side=${side} songs=${partitionSongs.length}`,
      );
    }
    return songs;
  }

  private async fetchFriendVsUrl(
    url: string,
    retryCount: number = RETRY.friendVSCount,
  ): Promise<FriendVsSong[]> {
    const result = await this.http.requestPage({
      url,
      policy: {
        timeoutMs: TIMEOUTS.friendVS,
        retryCount,
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
  return diff !== 10 && isFriendVsTransportFallbackError(error);
}

function isFriendVsTransportFallbackError(error: unknown): boolean {
  if (
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

function getFriendVsCacheType(scoreType: 1 | 2, side?: FriendVsSide): number {
  if (!side) {
    return scoreType;
  }
  return scoreType * 10 + (side === "win" ? 1 : side === "lose" ? 2 : 3);
}
