export function parseDxScore(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function getDxStar(dxPercent: number): number {
  if (dxPercent <= 85) {
    return 0;
  }
  if (dxPercent <= 90) {
    return 1;
  }
  if (dxPercent <= 93) {
    return 2;
  }
  if (dxPercent <= 95) {
    return 3;
  }
  if (dxPercent <= 97) {
    return 4;
  }
  return 5;
}

export function getDxStarForScore(
  dxScore: number | null,
  maxDxScore: number | null,
): number | null {
  if (dxScore === null || maxDxScore === null || maxDxScore <= 0) {
    return null;
  }
  return getDxStar((dxScore / maxDxScore) * 100);
}
