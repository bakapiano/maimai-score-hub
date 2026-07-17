import { z } from "zod";

import { SdgbJobTypeSchema, SdgbWorkerLaneSchema } from "./sdgb-worker.schema";

export const SdgbWorkerClassSchema = z.enum(["recoverable", "stable"]);
export const SdgbWorkerLifecycleStateSchema = z.enum([
  "running",
  "draining",
  "cleanup_handoff_ready",
  "blocked",
]);
export const SdgbUpstreamHealthSchema = z.enum([
  "unknown",
  "healthy",
  "degraded",
  "blocked",
]);
export const SdgbBreakerStateSchema = z.enum(["closed", "open", "half_open"]);
export const SdgbAutoRecoveryStateSchema = z.enum([
  "idle",
  "requested",
  "running",
  "verifying",
  "failed",
]);
export const SdgbLaneMembershipStateSchema = z.enum(["active", "draining"]);
export const SdgbDesiredMembershipStateSchema = z.enum([
  "active",
  "draining",
  "inactive",
]);

export const SdgbReportedLaneMembershipSchema = z.object({
  lane: SdgbWorkerLaneSchema,
  state: SdgbLaneMembershipStateSchema,
  membershipEpoch: z.number().int().positive(),
});

export const SdgbWorkerHeartbeatSchema = z.object({
  workerId: z.string().trim().min(1).max(128),
  workerClass: SdgbWorkerClassSchema,
  autoRecoveryHookKind: z.string().trim().min(1).max(128).optional(),
  version: z.string().trim().min(1).max(128),
  processGeneration: z.string().trim().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  lifecycleState: SdgbWorkerLifecycleStateSchema,
  capabilities: z.array(SdgbWorkerLaneSchema).min(1),
  laneMemberships: z.array(SdgbReportedLaneMembershipSchema),
  publicIp: z.string().trim().min(1).max(128).optional(),
  networkEpoch: z.number().int().nonnegative(),
  upstreamHealth: SdgbUpstreamHealthSchema,
  breakerState: SdgbBreakerStateSchema,
  autoRecoveryState: SdgbAutoRecoveryStateSchema.optional(),
  ratePolicyMode: z.enum(["none", "strict"]),
  activeJobsByType: z.record(SdgbJobTypeSchema, z.number().int().nonnegative()),
  shutdownBlockers: z
    .array(
      z.object({
        jobId: z.string().min(1),
        jobType: SdgbJobTypeSchema,
        phase: z.string().min(1),
      }),
    )
    .optional(),
  jobsClaimedDelta: z.number().int().nonnegative(),
});

export const SdgbDesiredLaneMembershipSchema = z.object({
  state: SdgbDesiredMembershipStateSchema,
  expectedMembershipEpoch: z.number().int().positive().optional(),
});

export const SdgbWorkerDesiredStateSchema = z.object({
  desiredLaneMemberships: z.object({
    probe: SdgbDesiredLaneMembershipSchema.optional(),
    interactive: SdgbDesiredLaneMembershipSchema.optional(),
  }),
  maintenanceRequestId: z.string().optional(),
});

export const SdgbWorkerIncidentSchema = z.object({
  incidentId: z.string().min(1).max(128),
  workerId: z.string().min(1).max(128),
  workerClass: SdgbWorkerClassSchema,
  publicIp: z.string().min(1).max(128).optional(),
  networkEpoch: z.number().int().nonnegative(),
  laneMemberships: z.array(
    z.object({
      lane: SdgbWorkerLaneSchema,
      membershipEpoch: z.number().int().positive(),
    }),
  ),
  failureClass: z.literal("empty_response"),
  consecutiveCount: z.number().int().positive(),
  observationWindowMs: z.number().int().positive(),
  activeJobsByType: z.record(SdgbJobTypeSchema, z.number().int().nonnegative()),
  occurredAt: z.string().datetime(),
});

export const SdgbMaintenanceReasonSchema = z.enum([
  "scheduled",
  "manual",
  "network_recovery",
  "deploy",
]);
export const SdgbMaintenanceStateSchema = z.enum([
  "requested",
  "planning_coverage",
  "draining_target",
  "coverage_activating",
  "coverage_ready",
  "hook_running",
  "recovery_verifying",
  "restoring_membership",
  "completed",
  "aborted",
  "degraded_coverage_active",
]);
export const CreateSdgbMaintenanceRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetWorkerId: z.string().min(1).max(128),
  affectedLanes: z.array(SdgbWorkerLaneSchema).min(1),
  hookKind: z.string().min(1).max(128),
  reason: SdgbMaintenanceReasonSchema,
  deadlineAt: z.string().datetime(),
});
export const SdgbHookObservationSchema = z.object({
  hookAccepted: z.boolean(),
  connectivityRestored: z.boolean(),
  publicIpBefore: z.string().min(1).max(128).optional(),
  publicIpAfter: z.string().min(1).max(128).optional(),
  completedAt: z.string().datetime(),
});

export interface SdgbLanePolicy {
  lane: SdgbWorkerLane;
  preferredClass: SdgbWorkerClass;
  preferredActiveCount: number;
  fallbackClass: SdgbWorkerClass;
  fallbackActiveCount: number;
}

export interface SdgbDesiredMember {
  workerId: string;
  workerClass: SdgbWorkerClass;
  membershipEpoch: number;
  state: "active" | "draining";
}

export interface SdgbDesiredMemberSet {
  lane: SdgbWorkerLane;
  revision: string;
  updatedAt: string;
  members: SdgbDesiredMember[];
}

export type SdgbWorkerLane = z.infer<typeof SdgbWorkerLaneSchema>;
export type SdgbWorkerClass = z.infer<typeof SdgbWorkerClassSchema>;
export type SdgbWorkerLifecycleState = z.infer<
  typeof SdgbWorkerLifecycleStateSchema
>;
export type SdgbUpstreamHealth = z.infer<typeof SdgbUpstreamHealthSchema>;
export type SdgbBreakerState = z.infer<typeof SdgbBreakerStateSchema>;
export type SdgbAutoRecoveryState = z.infer<typeof SdgbAutoRecoveryStateSchema>;
export type SdgbReportedLaneMembership = z.infer<
  typeof SdgbReportedLaneMembershipSchema
>;
export type SdgbWorkerHeartbeat = z.infer<typeof SdgbWorkerHeartbeatSchema>;
export type SdgbDesiredLaneMembership = z.infer<
  typeof SdgbDesiredLaneMembershipSchema
>;
export type SdgbWorkerDesiredState = z.infer<
  typeof SdgbWorkerDesiredStateSchema
>;
export type SdgbWorkerIncident = z.infer<typeof SdgbWorkerIncidentSchema>;
export type SdgbMaintenanceReason = z.infer<
  typeof SdgbMaintenanceReasonSchema
>;
export type SdgbMaintenanceState = z.infer<
  typeof SdgbMaintenanceStateSchema
>;
export type CreateSdgbMaintenanceRequest = z.infer<
  typeof CreateSdgbMaintenanceRequestSchema
>;
export type SdgbHookObservation = z.infer<
  typeof SdgbHookObservationSchema
>;
