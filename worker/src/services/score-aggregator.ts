/**
 * 成绩聚合服务
 * 负责获取和聚合 Friend VS 成绩数据
 */

import type {
  AggregatedScoreResult,
  FriendVsSong,
  ParsedScoreResult,
} from "../types/index.ts";
import { DIFFICULTIES, WORKER_DEFAULTS } from "../constants.ts";
import { getCachedHtml, setCachedHtml } from "../job-temp-cache-client.ts";

import { MaimaiHttpClient, sleep } from "./maimai-client.ts";
import { parseFriendVsSongs } from "../parsers/index.ts";

export interface ScoreFetchOptions {
  /** Job ID（用于缓存恢复） */
  jobId?: string;
  /** 是否导出 HTML（调试用） */
  dumpHtml?: (
    html: string,
    meta: { type: number; diff: number },
  ) => Promise<void>;
  /** 并发数 */
  concurrency?: number;
  /** 难度完成回调（每完成一个难度的两种类型时调用） */
  onDiffCompleted?: (diff: number) => Promise<void>;
}

/**
 * 成绩聚合器
 */
export class ScoreAggregator {
  private client: MaimaiHttpClient;

  constructor(client: MaimaiHttpClient) {
    this.client = client;
  }

  /**
   * 获取并聚合所有难度的成绩
   */
  async fetchAndAggregate(
    friendCode: string,
    options: ScoreFetchOptions = {},
  ): Promise<AggregatedScoreResult> {
    const {
      jobId,
      dumpHtml,
      concurrency = WORKER_DEFAULTS.friendVSConcurrency,
      onDiffCompleted,
    } = options;

    // 收藏好友以解锁 Friend VS 功能，并验证收藏状态
    const maxFavoriteRetries = 3;
    for (let attempt = 1; attempt <= maxFavoriteRetries; attempt++) {
      await this.client.favoriteOnFriend(friendCode);

      const friends = await this.client.getFriendList();
      const friendInfo = friends.find((f) => f.friendCode === friendCode);
      if (friendInfo?.isFavorite) {
        break;
      }

      if (attempt < maxFavoriteRetries) {
        console.warn(
          `[ScoreAggregator] Friend ${friendCode} not favorited after attempt ${attempt}/${maxFavoriteRetries}, retrying...`,
        );
        await sleep(10_000);
      } else {
        console.warn(
          `[ScoreAggregator] Friend ${friendCode} not confirmed as favorited after ${maxFavoriteRetries} attempts, proceeding anyway`,
        );
      }
    }

    // 跟踪每个难度的完成状态（需要两种类型都完成）
    const diffCompletionCount = new Map<number, number>();
    const notifyDiffCompleted = async (diff: number) => {
      if (!onDiffCompleted) return;
      const count = (diffCompletionCount.get(diff) ?? 0) + 1;
      diffCompletionCount.set(diff, count);
      // 每个难度有两种类型（dxScore 和 score），都完成后才通知
      if (count >= 2) {
        await onDiffCompleted(diff);
      }
    };

    const tasks: Array<() => Promise<ParsedScoreResult>> = [];

    for (const diff of DIFFICULTIES) {
      // scoreType 1 = dxScore
      tasks.push(async () => {
        let html: string | null = null;

        // 如果有 jobId，先尝试从缓存获取
        if (jobId) {
          html = await getCachedHtml(jobId, diff, 1);
        }

        // 缓存未命中，调用网络
        if (!html) {
          html = await this.client.getFriendVS(friendCode, 1, diff);

          // 保存到缓存
          if (jobId) {
            await setCachedHtml(jobId, diff, 1, html);
          }
        }

        if (dumpHtml) {
          await dumpHtml(html, { type: 1, diff });
        }
        const parsed = {
          diff,
          type: 1 as const,
          songs: parseFriendVsSongs(html),
        };
        await notifyDiffCompleted(diff);
        return parsed;
      });

      // scoreType 2 = score (达成率)
      tasks.push(async () => {
        let html: string | null = null;

        // 如果有 jobId，先尝试从缓存获取
        if (jobId) {
          html = await getCachedHtml(jobId, diff, 2);
        }

        // 缓存未命中，调用网络
        if (!html) {
          html = await this.client.getFriendVS(friendCode, 2, diff);

          // 保存到缓存
          if (jobId) {
            await setCachedHtml(jobId, diff, 2, html);
          }
        }

        if (dumpHtml) {
          await dumpHtml(html, { type: 2, diff });
        }
        const parsed = {
          diff,
          type: 2 as const,
          songs: parseFriendVsSongs(html),
        };
        await notifyDiffCompleted(diff);
        return parsed;
      });
    }

    const scores = await runWithConcurrency(tasks, concurrency);
    return this.aggregateResults(scores);
  }

  /**
   * 聚合多个难度的成绩结果
   */
  private aggregateResults(
    results: ParsedScoreResult[],
  ): AggregatedScoreResult {
    const aggregated: AggregatedScoreResult = {};

    for (const result of results) {
      for (const song of result.songs) {
        const category = song.category ?? "unknown";
        const type = song.type;

        if (!aggregated[category]) {
          aggregated[category] = {};
        }

        if (!aggregated[category][type]) {
          aggregated[category][type] = {};
        }

        const songsByType = aggregated[category][type]!;

        if (!songsByType[song.name]) {
          songsByType[song.name] = {};
        }

        if (!songsByType[song.name][result.diff]) {
          songsByType[song.name][result.diff] = {
            level: song.level,
          };
        }

        const entry = songsByType[song.name][result.diff];
        if (result.type === 1) {
          entry.dxScore = song.score ?? null;
        } else if (result.type === 2) {
          entry.score = song.score ?? null;
        }

        entry.fs = song.fs ?? null;
        entry.fc = song.fc ?? null;
      }
    }

    return aggregated;
  }
}

/**
 * 带并发限制的任务执行器
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  const workers = new Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(async () => {
      while (next < tasks.length) {
        const current = next++;
        results[current] = await tasks[current]();
      }
    });

  await Promise.all(workers);
  return results;
}
