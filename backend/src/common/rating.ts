export interface RankDef {
  minAchv: number;
  factor: number;
  title: string;
  maxAchv?: number;
  maxFactor?: number;
}

export interface B50ScoreLike {
  rating: number | null;
  isNew: boolean | null;
  type?: string | null;
}

export interface B50RatingSummary<T extends B50ScoreLike> {
  newTop: T[];
  oldTop: T[];
  newSum: number;
  oldSum: number;
  totalSum: number;
}

const RANK_SSS_PLUS: RankDef = {
  minAchv: 100.5,
  factor: 0.224,
  title: 'SSS+',
};

const RANK_DEFINITIONS: ReadonlyArray<RankDef> = [
  RANK_SSS_PLUS,
  {
    minAchv: 100.0,
    factor: 0.216,
    title: 'SSS',
    maxAchv: 100.4999,
    maxFactor: 0.222,
  },
  {
    minAchv: 99.5,
    factor: 0.211,
    title: 'SS+',
    maxAchv: 99.9999,
    maxFactor: 0.214,
  },
  { minAchv: 99.0, factor: 0.208, title: 'SS' },
  {
    minAchv: 98.0,
    factor: 0.203,
    title: 'S+',
    maxAchv: 98.9999,
    maxFactor: 0.206,
  },
  { minAchv: 97.0, factor: 0.2, title: 'S' },
  {
    minAchv: 94.0,
    factor: 0.168,
    title: 'AAA',
    maxAchv: 96.9999,
    maxFactor: 0.176,
  },
  { minAchv: 90.0, factor: 0.152, title: 'AA' },
  { minAchv: 80.0, factor: 0.136, title: 'A' },
  {
    minAchv: 75.0,
    factor: 0.12,
    title: 'BBB',
    maxAchv: 79.9999,
    maxFactor: 0.128,
  },
  { minAchv: 70.0, factor: 0.112, title: 'BB' },
  { minAchv: 60.0, factor: 0.096, title: 'B' },
  { minAchv: 50.0, factor: 0.08, title: 'C' },
  { minAchv: 0.0, factor: 0.016, title: 'D' },
];

export function getRankDefinitions() {
  return RANK_DEFINITIONS;
}

export function getRankIndexByAchievement(achievement: number) {
  return RANK_DEFINITIONS.findIndex((rank) => achievement >= rank.minAchv);
}

export function getRankByAchievement(achievement: number) {
  const idx = getRankIndexByAchievement(achievement);
  return idx < 0 ? null : RANK_DEFINITIONS[idx];
}

export function normalizeAchievement(
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const withoutPercent = trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed;
  const parsed = Number(withoutPercent);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getRating(level: number, achv: number) {
  const achievement = Math.min(achv, RANK_SSS_PLUS.minAchv);
  const rank = getRankByAchievement(achievement);
  if (!rank) {
    return 0;
  }

  const positiveLv = Math.abs(level);
  if (rank.maxAchv && rank.maxFactor && rank.maxAchv === achv) {
    return Math.floor(positiveLv * rank.maxAchv * rank.maxFactor);
  }
  return Math.floor(positiveLv * achievement * rank.factor);
}

/** Standard maimai B50: top 15 current-version charts + top 35 old charts. */
export function buildB50RatingSummary<T extends B50ScoreLike>(
  scores: readonly T[],
): B50RatingSummary<T> {
  const withRating = scores.filter(
    (score) => typeof score.rating === 'number' && score.type !== 'utage',
  );
  const newTop = withRating
    .filter((score) => score.isNew === true)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 15);
  const oldTop = withRating
    .filter((score) => score.isNew === false)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 35);
  const newSum = newTop.reduce((sum, score) => sum + (score.rating ?? 0), 0);
  const oldSum = oldTop.reduce((sum, score) => sum + (score.rating ?? 0), 0);

  return {
    newTop,
    oldTop,
    newSum,
    oldSum,
    totalSum: newSum + oldSum,
  };
}
