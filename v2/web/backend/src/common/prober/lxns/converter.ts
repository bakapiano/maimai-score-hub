import type { SyncScore } from '../../../modules/sync/sync.schema';
import { normalizeAchievement } from '../../rating';

export type LxnsScore = {
  id: number;
  song_name?: string;
  level?: string;
  level_index: number;
  achievements?: number | null;
  fc?: string | null;
  fs?: string | null;
  dx_score?: number | null;
  dx_star?: number | null;
  dx_rating?: number | null;
  rate?: string | null;
  type: string;
  play_time?: string | null;
  upload_time?: string | null;
  last_played_time?: string | null;
};

function mapType(type: string) {
  return type;
}

function mapFs(fs: string | null | undefined): string | null {
  if (!fs) return null;
  switch (fs.toLowerCase()) {
    case 'fdxp':
      return 'fsdp';
    case 'fdx':
      return 'fsd';
    case 'fsp':
      return 'fsp';
    case 'fs':
      return 'fs';
    default:
      return null;
  }
}

function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapMusicId(type: string, id: string): number {
  const parsed = Number(id);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid musicId for LXNS payload: ${id}`);
  }
  return type === 'dx' ? parsed - 10000 : parsed;
}

export function convertSyncScoresToLxnsPayload(scores: SyncScore[]): {
  scores: LxnsScore[];
} {
  const payload: LxnsScore[] = [];

  for (const score of scores) {
    const id = mapMusicId(score.type, score.musicId);
    const levelIndex = score.type === 'utage' ? 0 : score.chartIndex;
    payload.push({
      id,
      level_index: levelIndex,
      achievements: normalizeAchievement(score.score),
      fc: score.fc ?? null,
      fs: mapFs(score.fs),
      dx_score: toNumber(score.dxScore),
      dx_star: 0,
      type: mapType(score.type),
    });
  }

  return { scores: payload };
}