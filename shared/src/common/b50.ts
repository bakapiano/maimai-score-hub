export interface B50ScoreLike {
  musicId: string;
  rating?: number | null;
  isNew?: boolean | null;
  type?: string | null;
}

/** A current catalog ID lookup, accepted as either a Set or a music Map. */
export type B50MusicCatalog = Pick<ReadonlySet<string>, 'has'>;

export interface B50RatingSummary<T extends B50ScoreLike> {
  newTop: T[];
  oldTop: T[];
  newSum: number;
  oldSum: number;
  totalSum: number;
}

/**
 * B50 from the current catalog: top 15 new charts + top 35 old charts.
 * Filter before selecting the top charts so active runners-up fill vacancies.
 * The catalog is required; an empty catalog yields an empty B50. Historical
 * score snapshots and their objects remain unchanged.
 */
export function buildB50RatingSummary<T extends B50ScoreLike>(
  scores: readonly T[],
  musicCatalog: B50MusicCatalog,
): B50RatingSummary<T> {
  const withRating = scores.filter(
    (score) =>
      musicCatalog.has(score.musicId) &&
      typeof score.rating === 'number' &&
      Number.isFinite(score.rating) &&
      score.type !== 'utage',
  );
  const newTop = withRating
    .filter((score) => score.isNew === true)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 15);
  const oldTop = withRating
    .filter((score) => score.isNew === false)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 35);
  const newSum = newTop.reduce((sum, score) => sum + (score.rating ?? 0), 0);
  const oldSum = oldTop.reduce((sum, score) => sum + (score.rating ?? 0), 0);

  return { newTop, oldTop, newSum, oldSum, totalSum: newSum + oldSum };
}
