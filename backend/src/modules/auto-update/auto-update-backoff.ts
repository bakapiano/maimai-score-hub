/**
 * Exponential backoff policy for the auto-update scheduler. Pulled
 * into its own module so JobService (which records failures on the
 * dxnet update_score lifecycle transitions) can use the same
 * numbers as the scheduler (which reads autoUpdateBackoffUntil to
 * decide whether to skip a user) without creating a circular import
 * between the job and auto-update modules.
 *
 * Sequence with these defaults:
 *   failure 1 → 30m
 *   failure 2 → 1h
 *   failure 3 → 2h
 *   failure 4+ → 4h (cap)
 */
export const AUTO_UPDATE_BACKOFF_POLICY = {
  baseMs: 30 * 60 * 1000,
  factor: 2,
  capMs: 4 * 60 * 60 * 1000,
} as const;
