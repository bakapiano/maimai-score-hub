import type {
  ChartEntry,
  LevelBucket,
  MusicRow,
  RatingSummary,
  VersionBucket,
} from './score-export.types';

import type { ChartPayload } from '../music/schemas/music.schema';
import type { SyncScore } from '../sync/schemas/sync.schema';
import { VERSION_ORDER } from './rendering/score-export.constants';

export function buildRatingSummary(scores: SyncScore[]): RatingSummary | null {
  if (!Array.isArray(scores)) {
    return null;
  }
  const withRating = scores.filter(
    (s) => typeof s.rating === 'number' && s.type !== 'utage',
  );
  const newScores = withRating
    .filter((s) => s.isNew === true)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const oldScores = withRating
    .filter((s) => s.isNew === false)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

  const newTop = newScores.slice(0, 15);
  const oldTop = oldScores.slice(0, 35);

  const newSum = newTop.reduce((sum, s) => sum + (s.rating ?? 0), 0);
  const oldSum = oldTop.reduce((sum, s) => sum + (s.rating ?? 0), 0);

  return {
    newTop,
    oldTop,
    newSum,
    oldSum,
    totalSum: newSum + oldSum,
  };
}

export function buildLevelBuckets(
  musics: MusicRow[],
  scores: SyncScore[],
): LevelBucket[] {
  const scoreMap = new Map<string, SyncScore>();
  for (const s of scores) {
    scoreMap.set(`${s.musicId}-${s.chartIndex}`, s);
  }

  const levelMap = new Map<string, Map<string, ChartEntry[]>>();

  for (const music of musics) {
    const charts = music.charts ?? [];
    charts.forEach((chart, idx) => {
      const levelKey = normalizeLevelKey(chart);
      const detailKey = normalizeDetailKey(chart);
      const levelBucket =
        levelMap.get(levelKey) ?? new Map<string, ChartEntry[]>();
      if (!levelMap.has(levelKey)) {
        levelMap.set(levelKey, levelBucket);
      }
      const detailBucket = levelBucket.get(detailKey) ?? [];
      if (!levelBucket.has(detailKey)) {
        levelBucket.set(detailKey, detailBucket);
      }

      detailBucket.push({
        music,
        chart,
        chartIndex: idx,
        score: scoreMap.get(`${music.id}-${idx}`),
      });
    });
  }

  const buckets: LevelBucket[] = Array.from(levelMap.entries()).map(
    ([levelKey, detailMap]) => ({
      levelKey,
      levelNumeric: parseLevelValue(levelKey),
      details: Array.from(detailMap.entries())
        .map(([detailKey, items]) => ({
          detailKey,
          detailNumeric: parseLevelValue(detailKey),
          items: items.sort(
            (a, b) => (b.score?.rating ?? 0) - (a.score?.rating ?? 0),
          ),
        }))
        .sort(
          (a, b) =>
            (b.detailNumeric ?? -Infinity) - (a.detailNumeric ?? -Infinity),
        ),
    }),
  );

  buckets.sort((a, b) => {
    const numDiff =
      (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity);
    if (numDiff !== 0) {
      return numDiff;
    }
    return a.levelKey.localeCompare(b.levelKey);
  });

  return buckets;
}

export function buildVersionBuckets(
  musics: MusicRow[],
  scores: SyncScore[],
): VersionBucket[] {
  const scoreMap = new Map<string, SyncScore>();
  for (const s of scores) {
    scoreMap.set(`${s.musicId}-${s.chartIndex}`, s);
  }

  const versionMap = new Map<string, Map<string, ChartEntry[]>>();

  for (const music of musics) {
    const charts = music.charts ?? [];
    const versionKey = music.version || '未知版本';
    const levelMap =
      versionMap.get(versionKey) ?? new Map<string, ChartEntry[]>();
    if (!versionMap.has(versionKey)) {
      versionMap.set(versionKey, levelMap);
    }

    charts.forEach((chart, idx) => {
      const levelKey = normalizeLevelKey(chart);
      const list = levelMap.get(levelKey) ?? [];
      if (!levelMap.has(levelKey)) {
        levelMap.set(levelKey, list);
      }

      list.push({
        music,
        chart,
        chartIndex: idx,
        score: scoreMap.get(`${music.id}-${idx}`),
      });
    });
  }

  const buckets: VersionBucket[] = Array.from(versionMap.entries()).map(
    ([versionKey, levelMap]) => ({
      versionKey,
      levels: Array.from(levelMap.entries())
        .map(([levelKey, items]) => ({
          levelKey,
          levelNumeric: parseLevelValue(levelKey),
          items: items.sort(
            (a, b) => detailSortValue(b.chart) - detailSortValue(a.chart),
          ),
        }))
        .sort(
          (a, b) =>
            (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
        ),
    }),
  );

  buckets.sort((a, b) => {
    const aUnknown = a.versionKey === '未知版本';
    const bUnknown = b.versionKey === '未知版本';
    if (aUnknown && !bUnknown) {
      return 1;
    }
    if (!aUnknown && bUnknown) {
      return -1;
    }
    return (
      getVersionSortIndex(a.versionKey) - getVersionSortIndex(b.versionKey)
    );
  });

  return buckets;
}

export function normalizeLevelKey(chart: ChartPayload) {
  if (chart.level) {
    return chart.level;
  }
  if (typeof chart.detailLevel === 'number') {
    return Math.floor(chart.detailLevel).toString();
  }
  return '?';
}

export function normalizeDetailKey(chart: ChartPayload) {
  if (typeof chart.detailLevel === 'number') {
    return chart.detailLevel.toFixed(1);
  }
  if (chart.level) {
    return chart.level;
  }
  return '?';
}

export function parseLevelValue(value: string) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(\+)?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const base = parseFloat(match[1]);
  if (!Number.isFinite(base)) {
    return null;
  }
  return base + (match[2] ? 0.1 : 0);
}

export function detailSortValue(chart: ChartPayload) {
  if (typeof chart.detailLevel === 'number') {
    return chart.detailLevel;
  }
  if (chart.level) {
    const parsed = parseLevelValue(chart.level);
    if (parsed !== null) {
      return parsed;
    }
  }
  return -Infinity;
}

export function getVersionSortIndex(version: string): number {
  const index = VERSION_ORDER.indexOf(version);
  return index === -1 ? VERSION_ORDER.length : index;
}
