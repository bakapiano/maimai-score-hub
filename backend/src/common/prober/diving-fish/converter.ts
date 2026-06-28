import type { SyncScore } from '../../../modules/sync/schemas/sync.schema';
import { normalizeAchievement } from '../../rating';

export type DivingFishRecord = {
  achievements: number | null;
  dxScore: number | null;
  fc: string | null;
  fs: string | null;
  level_index: number;
  title: string;
  type: 'SD' | 'DX';
};

export type MusicTitleMap = Map<string, string>;

function mapType(type: string): 'SD' | 'DX' {
  if (type === 'dx' || type === 'utage') {
    return 'DX';
  }
  if (type === 'standard') {
    return 'SD';
  }
  // Default to DX for unknown non-standard types
  return 'DX';
}

function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function convertSyncScoreToDivingFishRecord(
  score: SyncScore,
  titleMap?: MusicTitleMap,
): DivingFishRecord {
  const achievements = normalizeAchievement(score.score);
  const dxScore = toNumber(score.dxScore);

  const titleFromMap = titleMap?.get(score.musicId);
  const title = titleFromMap || '未知曲目';

  return {
    achievements,
    dxScore,
    fc: score.fc ?? null,
    fs: score.fs ?? null,
    level_index: score.chartIndex,
    title,
    type: mapType(score.type),
  };
}

export function convertSyncScoresToDivingFishRecords(
  scores: SyncScore[],
  titleMap?: MusicTitleMap,
): DivingFishRecord[] {
  return scores.map((s) => convertSyncScoreToDivingFishRecord(s, titleMap));
}
