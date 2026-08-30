export function normalizeScoreSearch(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export type ScoreSearchSource = {
  musicId: string;
  title: string;
  type?: string;
  aliases: readonly string[];
};

export type ScoreSearchIndexEntry = ScoreSearchSource & {
  normalizedMusicId: string;
  normalizedTitle: string;
  normalizedAliases: string[];
  searchText: string;
};

export type ScoreSearchCandidate = {
  musicId: string;
  title: string;
  type?: string;
  matchedAlias?: string;
};

type FuzzyTerm = {
  normalized: string;
  alias?: string;
};

type RankedFuzzyCandidate = {
  candidate: ScoreSearchCandidate;
  similarity: number;
  order: number;
};

export class ScoreSearchEngine {
  private readonly index: readonly ScoreSearchIndexEntry[];
  private readonly fuzzyTerms: FuzzyTerm[][];
  private readonly bigramIndex = new Map<string, Set<number>>();
  private readonly characterIndex = new Map<string, Set<number>>();

  constructor(index: readonly ScoreSearchIndexEntry[]) {
    this.index = index;
    this.fuzzyTerms = index.map((entry, entryIndex) => {
      const terms = [
        { normalized: entry.normalizedTitle },
        ...entry.normalizedAliases.map((normalized, aliasIndex) => ({
          normalized,
          alias: entry.aliases[aliasIndex],
        })),
      ].filter(
        (term, termIndex, allTerms) =>
          term.normalized.length > 0 &&
          allTerms.findIndex(
            (candidate) => candidate.normalized === term.normalized,
          ) === termIndex,
      );
      for (const term of terms) {
        for (const bigram of this.bigrams(term.normalized)) {
          this.addToInvertedIndex(this.bigramIndex, bigram, entryIndex);
        }
        for (const character of new Set([...term.normalized])) {
          this.addToInvertedIndex(
            this.characterIndex,
            character,
            entryIndex,
          );
        }
      }
      return terms;
    });
  }

  candidates(query: string, limit = 8): ScoreSearchCandidate[] {
    const direct = searchScoreCandidates(this.index, query, limit);
    const normalizedQuery = normalizeScoreSearch(query);
    if (direct.length > 0 || normalizedQuery.length < 2) {
      return direct;
    }
    return this.fuzzyCandidates(normalizedQuery, limit);
  }

  matchingMusicIds(query: string): ReadonlySet<string> {
    const normalizedQuery = normalizeScoreSearch(query);
    if (!normalizedQuery) {
      return new Set(this.index.map((entry) => entry.musicId));
    }
    const direct = this.index.filter((entry) =>
      entry.searchText.includes(normalizedQuery),
    );
    if (direct.length > 0 || normalizedQuery.length < 2) {
      return new Set(direct.map((entry) => entry.musicId));
    }
    return new Set(
      this.fuzzyCandidates(normalizedQuery, 8).map(
        (candidate) => candidate.musicId,
      ),
    );
  }

  private fuzzyCandidates(
    normalizedQuery: string,
    limit: number,
  ): ScoreSearchCandidate[] {
    const ranked: RankedFuzzyCandidate[] = [];
    for (const entryIndex of this.fuzzyCandidateIndexes(normalizedQuery)) {
      const entry = this.index[entryIndex];
      let bestSimilarity = 0;
      let matchedAlias: string | undefined;
      for (const term of this.fuzzyTerms[entryIndex]) {
        const similarity = this.similarity(normalizedQuery, term.normalized);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          matchedAlias = term.alias;
        }
      }
      if (bestSimilarity < 0.62) {
        continue;
      }
      ranked.push({
        candidate: {
          musicId: entry.musicId,
          title: entry.title,
          type: entry.type,
          ...(matchedAlias ? { matchedAlias } : {}),
        },
        similarity: bestSimilarity,
        order: entryIndex,
      });
    }
    return ranked
      .sort(
        (left, right) =>
          right.similarity - left.similarity || left.order - right.order,
      )
      .slice(0, limit)
      .map((item) => item.candidate);
  }

  private fuzzyCandidateIndexes(query: string): number[] {
    const weights = new Map<number, number>();
    for (const bigram of this.bigrams(query)) {
      for (const entryIndex of this.bigramIndex.get(bigram) ?? []) {
        weights.set(entryIndex, (weights.get(entryIndex) ?? 0) + 3);
      }
    }
    for (const character of new Set([...query])) {
      for (const entryIndex of this.characterIndex.get(character) ?? []) {
        weights.set(entryIndex, (weights.get(entryIndex) ?? 0) + 1);
      }
    }
    return [...weights.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 300)
      .map(([entryIndex]) => entryIndex);
  }

  private similarity(leftValue: string, rightValue: string): number {
    const left = [...leftValue];
    const right = [...rightValue];
    const longest = Math.max(left.length, right.length);
    if (longest === 0) {
      return 1;
    }
    if (Math.min(left.length, right.length) / longest < 0.55) {
      return 0;
    }
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const current = [leftIndex + 1];
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        current[rightIndex + 1] = Math.min(
          current[rightIndex] + 1,
          previous[rightIndex + 1] + 1,
          previous[rightIndex] +
            (left[leftIndex] === right[rightIndex] ? 0 : 1),
        );
      }
      previous = current;
    }
    return 1 - previous[right.length] / longest;
  }

  private bigrams(value: string): Set<string> {
    const characters = [...value];
    const result = new Set<string>();
    for (let index = 0; index + 1 < characters.length; index += 1) {
      result.add(`${characters[index]}${characters[index + 1]}`);
    }
    return result;
  }

  private addToInvertedIndex(
    index: Map<string, Set<number>>,
    token: string,
    entryIndex: number,
  ): void {
    const values = index.get(token) ?? new Set<number>();
    values.add(entryIndex);
    index.set(token, values);
  }
}

export function buildScoreSearchIndex(
  sources: readonly ScoreSearchSource[],
): ScoreSearchIndexEntry[] {
  return sources.map((source) => {
    const normalizedMusicId = normalizeScoreSearch(source.musicId);
    const normalizedTitle = normalizeScoreSearch(source.title);
    const normalizedAliases = source.aliases.map(normalizeScoreSearch);
    return {
      ...source,
      normalizedMusicId,
      normalizedTitle,
      normalizedAliases,
      searchText: [
        normalizedMusicId,
        normalizedTitle,
        ...normalizedAliases,
      ].join("\u0000"),
    };
  });
}

export function scoreSearchIndexByMusicId(
  index: readonly ScoreSearchIndexEntry[],
): ReadonlyMap<string, ScoreSearchIndexEntry> {
  return new Map(index.map((entry) => [entry.musicId, entry]));
}

export function scoreMatchesNormalizedIndex(
  musicId: string,
  normalizedQuery: string,
  index: ReadonlyMap<string, ScoreSearchIndexEntry>,
): boolean {
  return !normalizedQuery || Boolean(index.get(musicId)?.searchText.includes(normalizedQuery));
}

export function searchScoreCandidates(
  index: readonly ScoreSearchIndexEntry[],
  query: string,
  limit = 8,
): ScoreSearchCandidate[] {
  const normalizedQuery = normalizeScoreSearch(query);
  if (!normalizedQuery) {
    return [];
  }

  return index
    .flatMap((entry, order) => {
      if (!entry.searchText.includes(normalizedQuery)) {
        return [];
      }
      const aliasIndex = entry.normalizedAliases.findIndex((alias) =>
        alias.includes(normalizedQuery),
      );
      const exact =
        entry.normalizedMusicId === normalizedQuery ||
        entry.normalizedTitle === normalizedQuery ||
        entry.normalizedAliases.includes(normalizedQuery);
      const prefix =
        entry.normalizedMusicId.startsWith(normalizedQuery) ||
        entry.normalizedTitle.startsWith(normalizedQuery) ||
        entry.normalizedAliases.some((alias) =>
          alias.startsWith(normalizedQuery),
        );
      return [
        {
          candidate: {
            musicId: entry.musicId,
            title: entry.title,
            type: entry.type,
            ...(aliasIndex >= 0
              ? { matchedAlias: entry.aliases[aliasIndex] }
              : {}),
          },
          rank: exact ? 0 : prefix ? 1 : 2,
          order,
        },
      ];
    })
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function scoreMatchesCatalogSearch(
  musicId: string,
  title: string,
  query: string,
  aliasMap: ReadonlyMap<string, readonly string[]>,
): boolean {
  const index = buildScoreSearchIndex([
    { musicId, title, aliases: aliasMap.get(musicId) ?? [] },
  ]);
  return scoreMatchesNormalizedIndex(
    musicId,
    normalizeScoreSearch(query),
    scoreSearchIndexByMusicId(index),
  );
}
