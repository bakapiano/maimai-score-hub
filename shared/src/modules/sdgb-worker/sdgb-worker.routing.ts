import {
  SDGB_INTERACTIVE_QUEUE_NAME,
  SDGB_PROBE_QUEUE_NAME,
} from "../../common/worker-queues";
import type { SdgbLanePolicy, SdgbWorkerLane } from "./sdgb-worker.control";
import type { SdgbJobType } from "./sdgb-worker.schema";

export type SdgbWorkerRole = SdgbWorkerLane | "all";

export const DEFAULT_SDGB_LANE_POLICIES: Record<
  SdgbWorkerLane,
  SdgbLanePolicy
> = {
  probe: {
    lane: "probe",
    preferredClass: "recoverable",
    preferredActiveCount: 1,
    fallbackClass: "stable",
    fallbackActiveCount: 1,
  },
  interactive: {
    lane: "interactive",
    preferredClass: "stable",
    preferredActiveCount: 1,
    fallbackClass: "recoverable",
    fallbackActiveCount: 1,
  },
};

export const SDGB_JOB_TYPES_BY_LANE = {
  probe: ["get_rival_hash", "get_user_map"],
  interactive: ["scan_qr", "add_rival", "get_music_score"],
} as const satisfies Record<SdgbWorkerLane, readonly SdgbJobType[]>;

export const SDGB_QUEUE_NAME_BY_LANE: Record<SdgbWorkerLane, string> = {
  probe: SDGB_PROBE_QUEUE_NAME,
  interactive: SDGB_INTERACTIVE_QUEUE_NAME,
};

const SDGB_LANE_BY_JOB_TYPE: Record<SdgbJobType, SdgbWorkerLane> = {
  scan_qr: "interactive",
  get_rival_hash: "probe",
  get_user_map: "probe",
  add_rival: "interactive",
  get_music_score: "interactive",
};

export function getSdgbWorkerLaneForJobType(
  jobType: SdgbJobType,
): SdgbWorkerLane {
  return SDGB_LANE_BY_JOB_TYPE[jobType];
}

export function getSdgbWorkerQueueNameForJobType(jobType: SdgbJobType): string {
  return SDGB_QUEUE_NAME_BY_LANE[getSdgbWorkerLaneForJobType(jobType)];
}

export function getSdgbWorkerLanesForRole(
  role: SdgbWorkerRole,
): readonly SdgbWorkerLane[] {
  return role === "all" ? ["probe", "interactive"] : [role];
}

export function getSdgbWorkerJobTypesForRole(
  role: SdgbWorkerRole,
): readonly SdgbJobType[] {
  return getSdgbWorkerLanesForRole(role).flatMap(
    (lane) => SDGB_JOB_TYPES_BY_LANE[lane],
  );
}

export function isSdgbWorkerRole(value: unknown): value is SdgbWorkerRole {
  return value === "probe" || value === "interactive" || value === "all";
}
