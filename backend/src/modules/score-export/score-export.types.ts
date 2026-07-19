import type { ChartPayload } from '../music/schemas/music.schema';
import type { MusicEntity } from '../music/schemas/music.schema';
import type { SyncScore } from '../sync/schemas/sync.schema';
import type { ScoreChangeValue } from '../sync/schemas/score-change.schema';

export type MusicRow = MusicEntity & { charts?: ChartPayload[] };

export type RatingSummary = {
  newTop: SyncScore[];
  oldTop: SyncScore[];
  newSum: number;
  oldSum: number;
  totalSum: number;
};

export type ChartEntry = {
  music: MusicRow;
  chart: ChartPayload;
  chartIndex: number;
  score?: SyncScore;
};

export type LevelBucket = {
  levelKey: string;
  levelNumeric: number | null;
  details: Array<{
    detailKey: string;
    detailNumeric: number | null;
    items: ChartEntry[];
  }>;
};

export type LevelGroup = {
  levelKey: string;
  levelNumeric: number | null;
  items: ChartEntry[];
};

export type VersionBucket = {
  versionKey: string;
  levels: LevelGroup[];
};

export type CompactCard = {
  musicId: string;
  chartIndex: number;
  type: string;
  score: string | null;
  dxScore: string | null;
  dxScoreMax: number | null;
  dxStar: number | null;
  rating: number | null;
  fc: string | null;
  fs: string | null;
  title: string;
  detailLevelText: string;
};

export type HistoryExportCard = {
  musicId: string;
  chartIndex: number;
  type: string;
  title: string;
  detailLevelText: string;
  observedAt: Date;
  isNew: boolean;
  before: ScoreChangeValue;
  after: ScoreChangeValue;
  achievementDelta: number | null;
  dxScoreDelta: number | null;
  ratingDelta: number | null;
  beforeDxStar: number | null;
  afterDxStar: number | null;
};

/** Plate plan types for version completion table */
export type PlatePlan = 'jiang' | 'ji' | 'wuwu' | 'shen';
