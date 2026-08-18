import {
  DXNET_ALL_DIFFICULTIES,
  DXNET_DEFAULT_DIFFICULTIES,
  type DxnetDifficulty,
} from "@maimai-score-hub/shared";

export function hasExistingDxnetScores(
  scoreCount: number | null | undefined,
): boolean {
  return (scoreCount ?? 0) > 0;
}

export function selectDxnetDifficulties(
  hasExistingScores: boolean,
  updateAllDifficulties: boolean,
): DxnetDifficulty[] | undefined {
  if (!hasExistingScores) {
    return undefined;
  }
  return [
    ...(updateAllDifficulties
      ? DXNET_ALL_DIFFICULTIES
      : DXNET_DEFAULT_DIFFICULTIES),
  ];
}
