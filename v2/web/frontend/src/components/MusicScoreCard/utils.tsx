// Utility functions for Music Score Card components

import { STROKE_STYLE } from "./constants";

export function getRank(scoreVal: number): string {
  if (scoreVal >= 100.5) return "SSS+";
  if (scoreVal >= 100) return "SSS";
  if (scoreVal >= 99.5) return "SS+";
  if (scoreVal >= 99) return "SS";
  if (scoreVal >= 98) return "S+";
  if (scoreVal >= 97) return "S";
  if (scoreVal >= 94) return "AAA";
  if (scoreVal >= 90) return "AA";
  if (scoreVal >= 80) return "A";
  return "F";
}

export function renderRank(
  r: string,
  opts?: { compact?: boolean; stroke?: boolean }
) {
  const isCompact = opts?.compact === true;
  const hasStroke = opts?.stroke === true;
  const textShadow =
    isCompact && !hasStroke
      ? "none"
      : "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000";
  const letterSpacing = isCompact ? (hasStroke ? 1 : 0) : 1;

  if (r === "SSS" || r === "SSS+") {
    const parts = [
      { ch: "S", color: "#f5d142" }, // gold
      { ch: "S", color: "#4ea3ff" }, // blue
      { ch: "S", color: "#ff4d4f" }, // red
    ];
    const extra = r.endsWith("+") ? [{ ch: "+", color: "#f5d142" }] : [];
    return (
      <span style={{ textShadow, letterSpacing }}>
        {parts.concat(extra).map((p, idx) => (
          <span
            key={`${p.ch}-${idx}`}
            style={{ color: p.color, ...STROKE_STYLE }}
          >
            {p.ch}
          </span>
        ))}
      </span>
    );
  }
  if (["S", "S+", "SS", "SS+"].includes(r)) {
    return (
      <span
        style={{
          color: "#f5d142",
          ...STROKE_STYLE,
          textShadow,
          letterSpacing,
        }}
      >
        {r}
      </span>
    ); // gold
  }
  if (["A", "AA", "AAA"].includes(r)) {
    return (
      <span
        style={{
          color: "#ff4d4f",
          ...STROKE_STYLE,
          textShadow,
          letterSpacing,
        }}
      >
        {r}
      </span>
    ); // red
  }
  return (
    <span
      style={{
        ...STROKE_STYLE,
        textShadow,
        letterSpacing,
      }}
    >
      {r}
    </span>
  );
}

/**
 * Parse score string to number
 */
export function parseScore(score: string | null): number | null {
  if (typeof score !== "string" || score.trim().length === 0) return null;
  const parsed = parseFloat(score.replace("%", ""));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Get rank from score string
 */
export function getRankFromScore(score: string | null): string {
  const parsed = parseScore(score);
  return parsed !== null ? getRank(parsed) : "N/A";
}

/**
 * Build cover URL from music ID
 */
export function getCoverUrl(musicId: string): string {
  return `/api/cover/${musicId}`;
}

/**
 * Get FC/FS icon URL
 */
export function getIconUrl(icon: string): string {
  return `https://maimai.wahlap.com/maimai-mobile/img/music_icon_${icon}.png`;
}
