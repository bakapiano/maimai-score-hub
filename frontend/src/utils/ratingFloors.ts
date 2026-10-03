import type { SyncScore } from "../types/syncScore";
import {
  buildB50RatingSummary,
  type B50MusicCatalog,
} from "@maimai-score-hub/shared";

export type RatingFloors = {
  newFloor: number | null;
  oldFloor: number | null;
};

function ratingOf(score: SyncScore) {
  return typeof score.rating === "number" ? score.rating : null;
}

function getTopFloor(scores: SyncScore[], limit: number) {
  if (scores.length === 0) {
    return 0;
  }
  if (scores.length < limit) {
    return 0;
  }
  return ratingOf(scores[limit - 1]) ?? 0;
}

export function getRatingFloors(
  scores: SyncScore[],
  musicCatalog: B50MusicCatalog,
): RatingFloors {
  const { newTop, oldTop } = buildB50RatingSummary(scores, musicCatalog);

  return {
    newFloor: getTopFloor(newTop, 15),
    oldFloor: getTopFloor(oldTop, 35),
  };
}

export function getRatingFloorByIsNew(
  isNew: boolean | null | undefined,
  floors: RatingFloors,
) {
  if (isNew === true) {
    return floors.newFloor;
  }
  if (isNew === false) {
    return floors.oldFloor;
  }
  return null;
}
