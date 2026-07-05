/**
 * 成绩聚合服务
 * 负责获取和聚合 Friend VS 成绩数据
 */

import type {
  AggregatedScoreResult,
  ParsedScoreResult,
} from "../../../../../common/types.ts";
import { DIFFICULTIES } from "../../../../../common/maimai/constants.ts";
import { WORKER_DEFAULTS } from "../../../../../common/config.ts";
import { MaimaiClient } from "../../../../../common/maimai/client.ts";

interface ScoreFetchOptions {
  /** Job ID（用于缓存恢复） */
  jobId?: string;
  /** 并发数 */
  concurrency?: number;
  /** 指定要抓取的难度；为空则抓取默认全部难度 */
  difficulties?: readonly number[];
  /** 难度完成回调（每完成一个难度的两种类型时调用） */
  onDiffCompleted?: (diff: number) => Promise<void>;
}

/**
 * 成绩聚合器
 */
export class ScoreAggregator {
  private client: MaimaiClient;

  constructor(client: MaimaiClient) {
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
      concurrency = WORKER_DEFAULTS.friendVSConcurrency,
      difficulties = DIFFICULTIES,
      onDiffCompleted,
    } = options;

    const notifyDiffCompleted = async (diff: number) => {
      if (onDiffCompleted) {
        await onDiffCompleted(diff);
      }
    };

    const tasks: Array<() => Promise<ParsedScoreResult>> = [];

    const buildTask =
      (scoreType: 1 | 2, diff: number) =>
      async (): Promise<ParsedScoreResult> => {
        const songs = await this.client.scores.getFriendVS(
          friendCode,
          scoreType,
          diff,
          undefined,
          { jobId },
        );
        const parsed = { diff, type: scoreType, songs };
        await notifyDiffCompleted(diff);
        return parsed;
      };

    for (const diff of difficulties) {
      tasks.push(buildTask(1, diff));
      tasks.push(buildTask(2, diff));
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
