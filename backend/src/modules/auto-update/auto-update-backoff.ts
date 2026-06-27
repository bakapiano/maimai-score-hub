/**
 * Exponential backoff policy for rival-first auto-update probes.
 *
 * Sequence with these defaults:
 *   failure 1 → 15m
 *   failure 2 → 30m
 *   failure 3 → 1h
 *   failure 4 → 2h
 *   failure 5+ → 4h (cap)
 */
export const AUTO_UPDATE_BACKOFF_POLICY = {
  baseMs: 15 * 60 * 1000,
  factor: 2,
  capMs: 4 * 60 * 60 * 1000,
} as const;
