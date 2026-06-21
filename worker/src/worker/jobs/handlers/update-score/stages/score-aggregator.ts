/**
 * 成绩聚合服务
 * 负责获取和聚合 Friend VS 成绩数据
 */

import type {
  AggregatedScoreResult,
  FriendVsSong,
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
  /** 难度完成回调（每完成一个难度的两种类型时调用） */
  onDiffCompleted?: (diff: number) => Promise<void>;
  /**
   * 要爬取的难度列表。默认跳过 BASIC(0) / ADVANCED(1) / 宴会场(10)，
   * 仅当用户显式触发"同步全部"时才传入完整 DIFFICULTIES。
   */
  diffs?: readonly number[];
  /**
   * 当 backend 已经从 sdgb 拿到了 cabinet 上的 dxScore + achievement
   * 时，friend-VS 的 scoreType=1 (dxScore) 页就可以省掉 — 我们只需要
   * scoreType=2 那一遍来拿 fc/fs（cabinet 不提供）。score 字段会被
   * backend 在 sync.service 用 cabinet 数据覆盖。
   */
  skipDxScoreFetch?: boolean;
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
      onDiffCompleted,
      diffs = DIFFICULTIES,
      skipDxScoreFetch = false,
    } = options;

    // 跟踪每个难度的完成状态。skipDxScoreFetch=true 时每 diff 只跑 1 次
    // (scoreType=2)，false 时跑 2 次 (1 + 2)。
    const expectedTypesPerDiff = skipDxScoreFetch ? 1 : 2;
    const diffCompletionCount = new Map<number, number>();
    const notifyDiffCompleted = async (diff: number) => {
      if (!onDiffCompleted) return;
      const count = (diffCompletionCount.get(diff) ?? 0) + 1;
      diffCompletionCount.set(diff, count);
      if (count >= expectedTypesPerDiff) {
        await onDiffCompleted(diff);
      }
    };

    const tasks: Array<() => Promise<ParsedScoreResult>> = [];

    // Friend-VS 默认页面会在歌曲数较多时截断，导致漏歌；改为分别请求
    // winOnly + loseOnly 两个页面再合并，以获得完整覆盖。
    const fetchOneSide = async (
      scoreType: 1 | 2,
      diff: number,
      side: "win" | "lose",
    ): Promise<FriendVsSong[]> =>
      this.client.scores.getFriendVS(friendCode, scoreType, diff, side, {
        jobId,
      });

    const mergeSongs = (a: FriendVsSong[], b: FriendVsSong[]): FriendVsSong[] => {
      const seen = new Set<string>();
      const out: FriendVsSong[] = [];
      for (const s of [...a, ...b]) {
        const key = JSON.stringify([s.name, s.type, s.level]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
      }
      return out;
    };

    const buildTask = (scoreType: 1 | 2, diff: number) => async (): Promise<ParsedScoreResult> => {
      const [winSongs, loseSongs] = await Promise.all([
        fetchOneSide(scoreType, diff, "win"),
        fetchOneSide(scoreType, diff, "lose"),
      ]);
      const songs = mergeSongs(winSongs, loseSongs);
      const parsed = { diff, type: scoreType, songs };
      await notifyDiffCompleted(diff);
      return parsed;
    };

    for (const diff of diffs) {
      // skipDxScoreFetch=true 时，scoreType=1 (dxScore) 那一遍由 backend
      // 用 sdgb cabinet data 填，worker 只需要 scoreType=2 拿 fc/fs。
      if (!skipDxScoreFetch) {
        tasks.push(buildTask(1, diff));
      }
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
