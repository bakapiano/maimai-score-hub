export type MusicChartPayload = {
  cid?: number;
  level?: string;
  detailLevel?: number | null;
  notes?: unknown;
  charter?: string | null;
};

export type MusicRow = {
  id: string;
  title: string;
  type: string;
  artist?: string | null;
  category?: string | null;
  bpm?: number | string | null;
  version?: string | null;
  isNew?: boolean | null;
  charts?: MusicChartPayload[];
};
