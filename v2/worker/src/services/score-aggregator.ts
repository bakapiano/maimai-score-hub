/**
 * 成绩聚合服务
 * 负责获取和聚合 Friend VS 成绩数据
 */

import { MaimaiHttpClient } from "./maimai-client.ts";
import { parseFriendVsSongs } from "../parsers/index.ts";
import { DIFFICULTIES, WORKER_DEFAULTS } from "../constants.ts";
import type {
  AggregatedScoreResult,
  FriendVsSong,
  ParsedScoreResult,
} from "../types/index.ts";

export interface ScoreFetchOptions {
  /** 是否导出 HTML（调试用） */
  dumpHtml?: (
    html: string,
    meta: { type: number; diff: number }
  ) => Promise<void>;
  /** 并发数 */
  concurrency?: number;
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
    options: ScoreFetchOptions = {}
  ): Promise<AggregatedScoreResult> {
    const { dumpHtml, concurrency = WORKER_DEFAULTS.friendVSConcurrency } =
      options;

    // 收藏好友以解锁 Friend VS 功能
    await this.client.favoriteOnFriend(friendCode);

    const tasks: Array<() => Promise<ParsedScoreResult>> = [];

    for (const diff of DIFFICULTIES) {
      // scoreType 1 = dxScore
      tasks.push(async () => {
        const result = await this.client.getFriendVS(friendCode, 1, diff);
        if (dumpHtml) {
          await dumpHtml(result, { type: 1, diff });
        }
        return { diff, type: 1 as const, songs: parseFriendVsSongs(result) };
      });

      // scoreType 2 = score (达成率)
      tasks.push(async () => {
        const result = await this.client.getFriendVS(friendCode, 2, diff);
        if (dumpHtml) {
          await dumpHtml(result, { type: 2, diff });
        }
        return { diff, type: 2 as const, songs: parseFriendVsSongs(result) };
      });
    }

    const scores = await runWithConcurrency(tasks, concurrency);
    return this.aggregateResults(scores);
  }

  /**
   * 聚合多个难度的成绩结果
   */
  private aggregateResults(
    results: ParsedScoreResult[]
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
  limit: number
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
