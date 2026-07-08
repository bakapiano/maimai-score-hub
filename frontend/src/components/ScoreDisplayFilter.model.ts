export type ScoreDisplayMode = "rank" | "score";

export type DisplayFilterSettings = {
  showFc: boolean;
  showFs: boolean;
  showScore: boolean;
  scoreDisplayMode: ScoreDisplayMode;
  scoreDecimals: number;
  scoreMin: number | null;
  scoreMax: number | null;
};

export const DEFAULT_DISPLAY_FILTER: DisplayFilterSettings = {
  showFc: true,
  showFs: true,
  showScore: true,
  scoreDisplayMode: "rank",
  scoreDecimals: 2,
  scoreMin: null,
  scoreMax: null,
};

export function matchesScoreFilter(
  scoreStr: string | null | undefined,
  settings: Pick<DisplayFilterSettings, "scoreMin" | "scoreMax">,
): boolean {
  const { scoreMin, scoreMax } = settings;
  if (scoreMin === null && scoreMax === null) {
    return true;
  }

  if (!scoreStr) {
    return scoreMin === null && scoreMax === null;
  }

  const parsed = parseFloat(scoreStr.replace("%", ""));
  if (Number.isNaN(parsed)) {
    return true;
  }

  if (scoreMin !== null && parsed < scoreMin) {
    return false;
  }
  if (scoreMax !== null && parsed > scoreMax) {
    return false;
  }
  return true;
}
