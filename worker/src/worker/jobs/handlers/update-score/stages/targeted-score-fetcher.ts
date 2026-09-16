import type { ScoreFetchTarget } from "@maimai-score-hub/shared";

import type {
  FriendVsSong,
  TargetedScoreEntry,
  TargetedScoreResult,
} from "../../../../../common/types.ts";
import { MaimaiClient } from "../../../../../common/maimai/client.ts";
import {
  planScoreFetchPages,
  type ScoreFetchPage,
} from "./score-fetch-planner.ts";

type FetchOptions = {
  jobId?: string;
  concurrency: number;
  fcfsOnly: boolean;
};

type PageResult = {
  page: ScoreFetchPage;
  scoreType: 1 | 2;
  songs: FriendVsSong[];
};

export class TargetedScoreFetcher {
  private readonly client: MaimaiClient;

  constructor(client: MaimaiClient) {
    this.client = client;
  }

  async fetch(
    friendCode: string,
    targets: readonly ScoreFetchTarget[],
    options: FetchOptions,
  ): Promise<TargetedScoreResult> {
    const pages = planScoreFetchPages(targets);
    const scoreTypes: Array<1 | 2> = options.fcfsOnly ? [2] : [1, 2];
    const tasks = pages.flatMap((page) =>
      scoreTypes.map(
        (scoreType) => () =>
          this.fetchPage(friendCode, page, scoreType, options.jobId),
      ),
    );
    const results = await runWithConcurrency(tasks, options.concurrency);
    const state = new TargetResultState(targets, scoreTypes, options.fcfsOnly);
    for (const result of results) {
      state.ingest(result);
    }

    const missing = state.missingPairs();
    if (missing.length) {
      const message = `Targeted Friend VS pages missed charts: ${missing
        .map(({ musicId, scoreType }) => `${musicId}/type${scoreType}`)
        .join(", ")}`;
      if (!options.fcfsOnly) throw new Error(message);
      console.warn(
        `[TargetedScoreFetcher] ${message}; returning covered FC/FS charts`,
      );
    }
    return { targetedScores: state.entries() };
  }

  private async fetchPage(
    friendCode: string,
    page: ScoreFetchPage,
    scoreType: 1 | 2,
    jobId?: string,
  ): Promise<PageResult> {
    const songs =
      page.kind === "genre"
        ? await this.client.scores.getFriendVsGenre(
            friendCode,
            scoreType,
            page.diff,
            page.genre,
            { jobId },
          )
        : await this.client.scores.getFriendVsLevel(
            friendCode,
            scoreType,
            page.level,
            { jobId },
          );
    return { page, scoreType, songs };
  }
}

class TargetResultState {
  private readonly targetsByKey = new Map<string, ScoreFetchTarget[]>();
  private readonly result = new Map<string, TargetedScoreEntry>();
  private readonly seen = new Map<1 | 2, Set<string>>();
  private readonly targets: readonly ScoreFetchTarget[];
  private readonly fcfsOnly: boolean;

  constructor(
    targets: readonly ScoreFetchTarget[],
    scoreTypes: readonly (1 | 2)[],
    fcfsOnly: boolean,
  ) {
    this.targets = targets;
    this.fcfsOnly = fcfsOnly;
    for (const target of targets) {
      const key = targetKey(target.title, target.type, target.diff);
      const rows = this.targetsByKey.get(key) ?? [];
      rows.push(target);
      this.targetsByKey.set(key, rows);
      this.result.set(target.musicId, { musicId: target.musicId });
    }
    for (const scoreType of scoreTypes) this.seen.set(scoreType, new Set());
  }

  ingest(input: PageResult): void {
    for (const song of input.songs) {
      const diff =
        song.diff ?? (input.page.kind === "genre" ? input.page.diff : -1);
      const matches = this.targetsByKey.get(
        targetKey(song.name, song.type, diff),
      );
      if (!matches) continue;
      for (const target of matches) {
        if (song.category && song.category !== target.category) continue;
        const entry = this.result.get(target.musicId)!;
        if (song.fc !== undefined) entry.fc = song.fc;
        if (song.fs !== undefined) entry.fs = song.fs;
        if (!this.fcfsOnly && input.scoreType === 1) entry.dxScore = song.score;
        if (!this.fcfsOnly && input.scoreType === 2) entry.score = song.score;
        this.seen.get(input.scoreType)?.add(target.musicId);
      }
    }
  }

  missingPairs(): Array<{ musicId: string; scoreType: 1 | 2 }> {
    return [...this.seen.entries()].flatMap(([scoreType, ids]) =>
      this.targets
        .filter((target) => !ids.has(target.musicId))
        .map((target) => ({ musicId: target.musicId, scoreType })),
    );
  }

  entries(): TargetedScoreEntry[] {
    const observed = new Set(
      [...this.seen.values()].flatMap((musicIds) => [...musicIds]),
    );
    return this.targets
      .filter((target) => observed.has(target.musicId))
      .map((target) => this.result.get(target.musicId)!);
  }
}

function targetKey(title: string, type: string, diff: number): string {
  return `${title}\u0000${type}\u0000${diff}`;
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}
