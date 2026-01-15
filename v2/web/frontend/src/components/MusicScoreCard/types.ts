// Types for Music Score Card components

export interface ChartPayload {
  level?: string;
  detailLevel?: number | null;
  charter?: string | null;
}

export interface SongMetadata {
  title?: string;
  artist?: string | null;
  category?: string | null;
  isNew?: boolean | null;
  bpm?: number | string | null;
  version?: string | null;
}

export interface MusicScoreCardProps {
  musicId: string;
  chartIndex: number;
  type: string;
  rating: number | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  chartPayload?: ChartPayload | null;
  songMetadata?: SongMetadata | null;
  bpm?: number | null;
  noteDesigner?: string | null;
  dxScore?: string | null;
}

export interface DetailedMusicScoreCardProps extends MusicScoreCardProps {
  playCount?: number | null;
  maxDxScore?: number | null;
  ranking?: number | null;
  isNew?: boolean | null;
}
