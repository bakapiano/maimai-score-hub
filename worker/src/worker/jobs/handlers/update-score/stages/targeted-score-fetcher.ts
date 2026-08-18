import type { ScoreFetchTarget } from "@maimai-score-hub/shared";

import type {
  FriendVsSong,
  TargetedScoreEntry,
  TargetedScoreResult,
} from "../../../../../common/types.ts";
import { MaimaiClient } from "../../../../../common/maimai/client.ts";
import {
  planScoreFetchPages,
  scoreFetchCandidatePages,
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

const FC_RANK = ["fc", "fcp", "ap", "app"];
const FS_RANK = ["fs", "fsp", "fdx", "fdxp"];

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
    const fetched = new Set<string>();
    for (const result of results) {
      state.ingest(result);
      fetched.add(fetchKey(result.page, result.scoreType));
    }

    const fallbackTasks = this.alternateFallbackTasks(
      friendCode,
      state,
      scoreTypes,
      fetched,
      options.jobId,
    );
    const fallbacks = await runWithConcurrency(
      fallbackTasks,
      options.concurrency,
    );
    for (const result of fallbacks) state.ingest(result);

    const missing = state.missingPairs();
    if (missing.length) {
      throw new Error(
        `Targeted Friend VS pages missed charts: ${missing
          .map(({ musicId, scoreType }) => `${musicId}/type${scoreType}`)
          .join(", ")}`,
      );
    }
    return { targetedScores: state.entries() };
  }

  private alternateFallbackTasks(
    friendCode: string,
    state: TargetResultState,
    scoreTypes: readonly (1 | 2)[],
    fetched: ReadonlySet<string>,
    jobId?: string,
  ): Array<() => Promise<PageResult>> {
    const pages = new Map<string, { page: ScoreFetchPage; scoreType: 1 | 2 }>();
    for (const { target, scoreType } of state.missingTargets(scoreTypes)) {
      for (const page of scoreFetchCandidatePages(target)) {
        const key = fetchKey(page, scoreType);
        if (!fetched.has(key)) pages.set(key, { page, scoreType });
      }
    }
    return [...pages.values()].map(
      ({ page, scoreType }) =>
        () =>
          this.fetchPage(friendCode, page, scoreType, jobId),
    );
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
        entry.fc = higherRank(FC_RANK, entry.fc, song.fc);
        entry.fs = higherRank(FS_RANK, entry.fs, song.fs);
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

  missingTargets(scoreTypes: readonly (1 | 2)[]) {
    return scoreTypes.flatMap((scoreType) => {
      const ids = this.seen.get(scoreType) ?? new Set<string>();
      return this.targets
        .filter((target) => !ids.has(target.musicId))
        .map((target) => ({ target, scoreType }));
    });
  }

  entries(): TargetedScoreEntry[] {
    return this.targets.map((target) => this.result.get(target.musicId)!);
  }
}

function targetKey(title: string, type: string, diff: number): string {
  return `${title}\u0000${type}\u0000${diff}`;
}

function fetchKey(page: ScoreFetchPage, scoreType: 1 | 2): string {
  return page.kind === "genre"
    ? `genre:${page.diff}:${page.genre}:type${scoreType}`
    : `level:${page.level}:type${scoreType}`;
}

function higherRank(
  ranks: readonly string[],
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  const leftRank = left ? ranks.indexOf(left) : -1;
  const rightRank = right ? ranks.indexOf(right) : -1;
  return rightRank > leftRank ? (right ?? null) : (left ?? null);
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
