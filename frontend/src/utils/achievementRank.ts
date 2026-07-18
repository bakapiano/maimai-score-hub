export function getAchievementRank(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const achievement =
    typeof value === "number"
      ? value
      : Number.parseFloat(value.replace("%", ""));
  if (!Number.isFinite(achievement)) {
    return null;
  }
  if (achievement >= 100.5) {
    return "SSS+";
  }
  if (achievement >= 100) {
    return "SSS";
  }
  if (achievement >= 99.5) {
    return "SS+";
  }
  if (achievement >= 99) {
    return "SS";
  }
  if (achievement >= 98) {
    return "S+";
  }
  if (achievement >= 97) {
    return "S";
  }
  if (achievement >= 94) {
    return "AAA";
  }
  if (achievement >= 90) {
    return "AA";
  }
  if (achievement >= 80) {
    return "A";
  }
  if (achievement >= 75) {
    return "BBB";
  }
  if (achievement >= 70) {
    return "BB";
  }
  if (achievement >= 60) {
    return "B";
  }
  if (achievement >= 50) {
    return "C";
  }
  return "D";
}
