import type { SyncScore } from '../../../modules/sync/sync.schema';
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

function mapType(type: string): 'SD' | 'DX' {
  if (type === 'dx' || type === 'utage') return 'DX';
  if (type === 'standard') return 'SD';
  // Default to DX for unknown non-standard types
  return 'DX';
}

function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function convertSyncScoreToDivingFishRecord(
  score: SyncScore,
): DivingFishRecord {
  const achievements = normalizeAchievement(score.score);
  const dxScore = toNumber(score.dxScore);

  return {
    achievements,
    dxScore,
    fc: score.fc ?? null,
    fs: score.fs ?? null,
    level_index: score.chartIndex,
    title: score.title,
    type: mapType(score.type),
  };
}

export function convertSyncScoresToDivingFishRecords(
  scores: SyncScore[],
): DivingFishRecord[] {
  return scores.map((s) => convertSyncScoreToDivingFishRecord(s));
}