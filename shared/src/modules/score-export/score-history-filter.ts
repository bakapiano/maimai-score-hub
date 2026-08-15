import type { ScoreChangeValue } from '../sync';

const ACHIEVEMENT_RANK_MINIMUMS = [
  100.5,
  100,
  99.5,
  99,
  98,
  97,
  94,
  90,
  80,
  75,
  70,
  60,
  50,
  0,
] as const;

const STATUS_ALIASES: Readonly<Record<string, string>> = {
  'fc+': 'fcp',
  'ap+': 'app',
  'fs+': 'fsp',
  'fdx+': 'fdxp',
  fsd: 'fdx',
  'fsd+': 'fdxp',
  fsdp: 'fdxp',
};

export type ScoreHistoryKeyChangeInput = {
  before: ScoreChangeValue;
  after: ScoreChangeValue;
  beforeDxStar: number | null;
  afterDxStar: number | null;
};

function achievementRankIndex(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const achievement =
    typeof value === 'number'
      ? value
      : Number.parseFloat(value.replace('%', ''));
  if (!Number.isFinite(achievement)) {
    return null;
  }
  return ACHIEVEMENT_RANK_MINIMUMS.findIndex(
    (minimum) => achievement >= minimum,
  );
}

function normalizedDxStar(value: number | null) {
  return value !== null && Number.isInteger(value) && value > 0 ? value : 0;
}

function normalizedStatus(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return STATUS_ALIASES[normalized] ?? normalized;
}

/**
 * Returns true when a history entry crosses an achievement-rank or DX-star
 * boundary, or changes either FC/FS status. Numeric improvements within the
 * same displayed tier are intentionally ignored.
 */
export function hasScoreHistoryKeyChange({
  before,
  after,
  beforeDxStar,
  afterDxStar,
}: ScoreHistoryKeyChangeInput) {
  return (
    achievementRankIndex(before.score) !== achievementRankIndex(after.score) ||
    normalizedDxStar(beforeDxStar) !== normalizedDxStar(afterDxStar) ||
    normalizedStatus(before.fc) !== normalizedStatus(after.fc) ||
    normalizedStatus(before.fs) !== normalizedStatus(after.fs)
  );
}
