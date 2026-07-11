import type { PlatePlan } from "../constants/platePlan";
import type { SyncScore } from "../types/syncScore";
import {
  statusMeetsFcBucket,
  statusMeetsFsBucket,
} from "./ScoreSummaryBadges.model";

export type PlateProgressEntry = {
  score?: Pick<SyncScore, "score" | "fc" | "fs">;
};

export type PlateCompletionDisplayMode = "classic" | "check";

export function isPlateEntryCompleted(
  entry: PlateProgressEntry,
  plan: PlatePlan,
): boolean {
  if (!entry.score) {
    return false;
  }
  switch (plan) {
    case "jiang": {
      const scoreText = entry.score.score ?? null;
      if (!scoreText) {
        return false;
      }
      const value = parseFloat(scoreText.replace("%", ""));
      return !Number.isNaN(value) && value >= 100;
    }
    case "ji":
      return statusMeetsFcBucket(entry.score.fc, "fc");
    case "shen":
      return statusMeetsFcBucket(entry.score.fc, "ap");
    case "wuwu":
      return statusMeetsFsBucket(entry.score.fs, "fdx");
  }
}
