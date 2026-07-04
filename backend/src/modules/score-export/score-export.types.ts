import type { ChartPayload } from '../music/schemas/music.schema';
import type { MusicEntity } from '../music/schemas/music.schema';
import type { SyncScore } from '../sync/schemas/sync.schema';

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

/** Plate plan types for version completion table */
export type PlatePlan = 'jiang' | 'ji' | 'wuwu' | 'shen';
