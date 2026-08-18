import type { ScoreFetchTarget } from "@maimai-score-hub/shared";

export type ScoreFetchPage =
  | {
      kind: "genre";
      diff: number;
      genre: number;
      estimatedSongs: number;
    }
  | { kind: "level"; level: number; estimatedSongs: number };

const GENRE_ROWS: Record<number, Record<number, number>> = {
  0: { 101: 88, 102: 319, 103: 153, 104: 241, 105: 384, 106: 134 },
  1: { 101: 88, 102: 319, 103: 153, 104: 241, 105: 384, 106: 134 },
  2: { 101: 88, 102: 319, 103: 153, 104: 241, 105: 383, 106: 134 },
  3: { 101: 88, 102: 319, 103: 153, 104: 241, 105: 383, 106: 134 },
  4: { 101: 15, 102: 31, 103: 14, 104: 16, 105: 53, 106: 3 },
  10: { 99: 60 },
};

const LEVEL_ROWS: Record<number, number> = {
  1: 12,
  2: 114,
  3: 280,
  4: 336,
  5: 339,
  6: 434,
  7: 338,
  8: 312,
  9: 275,
  10: 155,
  11: 151,
  12: 171,
  13: 190,
  14: 228,
  15: 199,
  16: 187,
  17: 219,
  18: 360,
  19: 473,
  20: 357,
  21: 198,
  22: 76,
  23: 2,
};

export function planScoreFetchPages(
  targets: readonly ScoreFetchTarget[],
): ScoreFetchPage[] {
  const uniqueTargets = [
    ...new Map(targets.map((target) => [target.musicId, target])).values(),
  ];
  const pages = new Map<string, ScoreFetchPage>();
  const candidates = new Map<string, string[]>();
  for (const target of uniqueTargets) {
    const targetPages = candidatePages(target);
    if (!targetPages.length) {
      throw new Error(`No Friend VS page covers chart ${target.musicId}`);
    }
    for (const page of targetPages) pages.set(pageKey(page), page);
    candidates.set(target.musicId, targetPages.map(pageKey));
  }

  const selected = selectForcedPages(uniqueTargets, candidates, pages);
  const remaining = uniqueTargets.filter(
    (target) => !isCovered(target, candidates, selected),
  );
  if (remaining.length) {
    selectMinimumWeightVertexCover(remaining, candidates, pages, selected);
  }
  for (const target of uniqueTargets) {
    if (!isCovered(target, candidates, selected)) {
      throw new Error(`Planner left chart uncovered: ${target.musicId}`);
    }
  }
  return [...selected].map((key) => pages.get(key)!).sort(comparePages);
}

function candidatePages(target: ScoreFetchTarget): ScoreFetchPage[] {
  const result: ScoreFetchPage[] = [];
  if (target.genre !== null) {
    const estimatedSongs = GENRE_ROWS[target.diff]?.[target.genre];
    if (estimatedSongs) {
      result.push({
        kind: "genre",
        diff: target.diff,
        genre: target.genre,
        estimatedSongs,
      });
    }
  }
  if (target.level !== null && LEVEL_ROWS[target.level]) {
    result.push({
      kind: "level",
      level: target.level,
      estimatedSongs: LEVEL_ROWS[target.level],
    });
  }
  return result;
}

function selectForcedPages(
  targets: readonly ScoreFetchTarget[],
  candidates: ReadonlyMap<string, string[]>,
  pages: ReadonlyMap<string, ScoreFetchPage>,
): Set<string> {
  const selected = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of targets) {
      if (isCovered(target, candidates, selected)) continue;
      const available = candidates.get(target.musicId) ?? [];
      if (available.length === 1) {
        selected.add(available[0]);
        changed = true;
      }
    }
  }
  for (const key of selected) {
    if (!pages.has(key)) throw new Error(`Unknown forced page ${key}`);
  }
  return selected;
}

function selectMinimumWeightVertexCover(
  targets: readonly ScoreFetchTarget[],
  candidates: ReadonlyMap<string, string[]>,
  pages: ReadonlyMap<string, ScoreFetchPage>,
  selected: Set<string>,
): void {
  const genreKeys = unique(
    targets
      .map((target) => candidates.get(target.musicId)![0])
      .filter((key) => key.startsWith("genre:")),
  );
  const levelKeys = unique(
    targets
      .flatMap((target) => candidates.get(target.musicId)!)
      .filter((key) => key.startsWith("level:")),
  );
  const source = 0;
  const genreOffset = 1;
  const levelOffset = genreOffset + genreKeys.length;
  const sink = levelOffset + levelKeys.length;
  const network = new FlowNetwork(sink + 1);
  const genreNode = new Map(
    genreKeys.map((key, index) => [key, genreOffset + index]),
  );
  const levelNode = new Map(
    levelKeys.map((key, index) => [key, levelOffset + index]),
  );
  const totalWeight = [...genreKeys, ...levelKeys].reduce(
    (sum, key) => sum + pageWeight(pages.get(key)!),
    0,
  );
  for (const key of genreKeys) {
    network.addEdge(source, genreNode.get(key)!, pageWeight(pages.get(key)!));
  }
  for (const key of levelKeys) {
    network.addEdge(levelNode.get(key)!, sink, pageWeight(pages.get(key)!));
  }
  for (const target of targets) {
    const targetCandidates = candidates.get(target.musicId) ?? [];
    const genre = targetCandidates.find((key) => key.startsWith("genre:"));
    const level = targetCandidates.find((key) => key.startsWith("level:"));
    if (!genre || !level) {
      throw new Error(`Target is not a bipartite edge: ${target.musicId}`);
    }
    network.addEdge(
      genreNode.get(genre)!,
      levelNode.get(level)!,
      totalWeight + 1,
    );
  }
  network.maxFlow(source, sink);
  const reachable = network.reachableFrom(source);
  for (const key of genreKeys) {
    if (!reachable.has(genreNode.get(key)!)) selected.add(key);
  }
  for (const key of levelKeys) {
    if (reachable.has(levelNode.get(key)!)) selected.add(key);
  }
}

function isCovered(
  target: ScoreFetchTarget,
  candidates: ReadonlyMap<string, string[]>,
  selected: ReadonlySet<string>,
): boolean {
  return (candidates.get(target.musicId) ?? []).some((key) =>
    selected.has(key),
  );
}

function pageWeight(page: ScoreFetchPage): number {
  return page.estimatedSongs * 1_000 + 1;
}

function pageKey(page: ScoreFetchPage): string {
  return page.kind === "genre"
    ? `genre:${page.diff}:${page.genre}`
    : `level:${page.level}`;
}

function comparePages(left: ScoreFetchPage, right: ScoreFetchPage): number {
  if (left.kind !== right.kind) return left.kind === "genre" ? -1 : 1;
  if (left.kind === "genre" && right.kind === "genre") {
    return left.diff - right.diff || left.genre - right.genre;
  }
  return left.kind === "level" && right.kind === "level"
    ? left.level - right.level
    : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

type FlowEdge = { to: number; reverse: number; capacity: number };

class FlowNetwork {
  private readonly graph: FlowEdge[][];

  constructor(size: number) {
    this.graph = Array.from({ length: size }, () => []);
  }

  addEdge(from: number, to: number, capacity: number): void {
    const forward = { to, reverse: this.graph[to].length, capacity };
    const reverse = { to: from, reverse: this.graph[from].length, capacity: 0 };
    this.graph[from].push(forward);
    this.graph[to].push(reverse);
  }

  maxFlow(source: number, sink: number): number {
    let flow = 0;
    while (true) {
      const levels = this.levels(source);
      if (levels[sink] < 0) return flow;
      const next = new Array(this.graph.length).fill(0) as number[];
      while (true) {
        const pushed = this.push(
          source,
          sink,
          Number.MAX_SAFE_INTEGER,
          levels,
          next,
        );
        if (pushed === 0) break;
        flow += pushed;
      }
    }
  }

  reachableFrom(source: number): Set<number> {
    const seen = new Set([source]);
    const queue = [source];
    while (queue.length) {
      const node = queue.shift()!;
      for (const edge of this.graph[node]) {
        if (edge.capacity > 0 && !seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return seen;
  }

  private levels(source: number): number[] {
    const levels = new Array(this.graph.length).fill(-1) as number[];
    levels[source] = 0;
    const queue = [source];
    while (queue.length) {
      const node = queue.shift()!;
      for (const edge of this.graph[node]) {
        if (edge.capacity > 0 && levels[edge.to] < 0) {
          levels[edge.to] = levels[node] + 1;
          queue.push(edge.to);
        }
      }
    }
    return levels;
  }

  private push(
    node: number,
    sink: number,
    flow: number,
    levels: number[],
    next: number[],
  ): number {
    if (node === sink) return flow;
    for (; next[node] < this.graph[node].length; next[node]++) {
      const edge = this.graph[node][next[node]];
      if (edge.capacity <= 0 || levels[edge.to] !== levels[node] + 1) continue;
      const pushed = this.push(
        edge.to,
        sink,
        Math.min(flow, edge.capacity),
        levels,
        next,
      );
      if (pushed <= 0) continue;
      edge.capacity -= pushed;
      this.graph[edge.to][edge.reverse].capacity += pushed;
      return pushed;
    }
    return 0;
  }
}
