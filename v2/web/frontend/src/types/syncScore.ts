export type SyncScore = {
  musicId: string;
  cid?: number;
  chartIndex: number;
  type: string;
  dxScore?: string | null;
  score?: string | null;
  fs?: string | null;
  fc?: string | null;
  rating?: number | null;
  isNew?: boolean | null;
};
