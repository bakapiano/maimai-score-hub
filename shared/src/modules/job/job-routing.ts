import { DXNET_PRIORITY } from "./job-priority";
import type {
  DxnetAssignmentMode,
  DxnetExecutionLane,
  DxnetJobSource,
  JobType,
} from "./job.schema";

export const DXNET_ROUTING_VERSION = 2 as const;

export const DXNET_DEADLINE_MS: Record<DxnetExecutionLane, number> = {
  interactive: 5 * 60_000,
  user_sync: 20 * 60_000,
  background: 6 * 60 * 60_000,
};

export type DxnetClaimFlow = "manual_update" | "qr_identity";

export interface DxnetRouteDefinition {
  lane: DxnetExecutionLane;
  priority: number;
  defaultAssignmentMode: DxnetAssignmentMode;
  claimFlow: DxnetClaimFlow | null;
}

/** Central source/job-type policy used by every producer. */
export function getDxnetRouteDefinition(
  source: DxnetJobSource,
  jobType: JobType,
): DxnetRouteDefinition {
  if (
    source === "user_interaction" &&
    (jobType === "send_friend_request" || jobType === "accept_friend_request")
  ) {
    return {
      lane: "interactive",
      priority: DXNET_PRIORITY.interactive,
      defaultAssignmentMode: "pinned",
      claimFlow: null,
    };
  }

  if (
    (source === "qr_login" || source === "cabinet_binding") &&
    jobType === "get_full_friend_list"
  ) {
    return {
      lane: "interactive",
      priority: DXNET_PRIORITY.immediate,
      defaultAssignmentMode: "claim",
      claimFlow: "qr_identity",
    };
  }

  if (source === "user_sync" && jobType === "update_score") {
    return {
      lane: "user_sync",
      priority: DXNET_PRIORITY.userSync,
      defaultAssignmentMode: "claim",
      claimFlow: "manual_update",
    };
  }

  if (source === "auto_update" && jobType === "update_score") {
    return {
      lane: "background",
      priority: DXNET_PRIORITY.background,
      defaultAssignmentMode: "claim",
      claimFlow: null,
    };
  }

  if (source === "maintenance" && jobType === "get_full_friend_list") {
    return {
      lane: "background",
      priority: DXNET_PRIORITY.maintenance,
      defaultAssignmentMode: "pinned",
      claimFlow: null,
    };
  }

  throw new Error(`Unsupported DXNet route: ${source}/${jobType}`);
}

export function getDxnetDeadlineAt(
  lane: DxnetExecutionLane,
  createdAt: Date,
): Date {
  return new Date(createdAt.getTime() + DXNET_DEADLINE_MS[lane]);
}

export function inferDxnetJobSource(
  jobType: JobType,
  context?: Record<string, unknown> | null,
): DxnetJobSource {
  if (
    jobType === "send_friend_request" ||
    jobType === "accept_friend_request"
  ) {
    return "user_interaction";
  }
  if (jobType === "get_full_friend_list") {
    const purpose = context?.purpose;
    if (purpose === "qr_login_resolution") return "qr_login";
    if (purpose === "cabinet_binding_resolution") return "cabinet_binding";
    return "maintenance";
  }
  if (
    (typeof context?.source === "string" &&
      context.source.startsWith("auto_update")) ||
    context?.autoUpdateFcfs === true
  ) {
    return "auto_update";
  }
  return "user_sync";
}
