import type {
  SdgbLanePolicy,
  SdgbWorkerClass,
  SdgbWorkerLane,
} from '@maimai-score-hub/shared';

export interface SdgbLaneCandidate {
  workerId: string;
  workerClass: SdgbWorkerClass;
  capabilities: readonly SdgbWorkerLane[];
  activeJobCount: number;
  healthySinceMs: number;
}

export function selectSdgbLaneMembers(
  policy: SdgbLanePolicy,
  candidates: readonly SdgbLaneCandidate[],
  currentMemberIds: ReadonlySet<string>,
): SdgbLaneCandidate[] {
  const eligible = candidates.filter((candidate) =>
    candidate.capabilities.includes(policy.lane),
  );
  const preferred = sortCandidates(
    eligible.filter(
      (candidate) => candidate.workerClass === policy.preferredClass,
    ),
    currentMemberIds,
  );
  if (preferred.length > 0) {
    return preferred.slice(0, positiveCount(policy.preferredActiveCount));
  }

  return sortCandidates(
    eligible.filter(
      (candidate) => candidate.workerClass === policy.fallbackClass,
    ),
    currentMemberIds,
  ).slice(0, positiveCount(policy.fallbackActiveCount));
}

function sortCandidates(
  candidates: readonly SdgbLaneCandidate[],
  currentMemberIds: ReadonlySet<string>,
): SdgbLaneCandidate[] {
  return [...candidates].sort((a, b) => {
    const existingDelta =
      Number(currentMemberIds.has(b.workerId)) -
      Number(currentMemberIds.has(a.workerId));
    if (existingDelta !== 0) {
      return existingDelta;
    }
    if (a.activeJobCount !== b.activeJobCount) {
      return a.activeJobCount - b.activeJobCount;
    }
    if (a.healthySinceMs !== b.healthySinceMs) {
      return a.healthySinceMs - b.healthySinceMs;
    }
    return a.workerId.localeCompare(b.workerId);
  });
}

function positiveCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
