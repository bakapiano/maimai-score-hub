import { initContract } from "@ts-rest/core";

import {
  SdgbJobPatchBodySchema,
  SdgbJobResponseSchema,
} from "./sdgb-worker.schema";
import {
  SdgbWorkerDesiredStateSchema,
  SdgbWorkerHeartbeatSchema,
  SdgbWorkerIncidentSchema,
} from "./sdgb-worker.control";

const c = initContract();

/**
 * Backend-side contract for the sdgb-worker.
 *
 * sdgb-worker consumes BullMQ jobs directly, loads the Mongo row by id,
 * runs one cabinet API call, then `patch`es the result. Producers inside
 * backend enqueue via SdgbJobService directly.
 */
export const sdgbWorkerContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/workers/sdgb/jobs/heartbeat",
    body: SdgbWorkerHeartbeatSchema,
    responses: { 200: SdgbWorkerDesiredStateSchema },
  },
  incident: {
    method: "POST",
    path: "/workers/sdgb/incidents",
    body: SdgbWorkerIncidentSchema,
    responses: {
      200: c.type<{ accepted: boolean; deduplicated: boolean }>(),
    },
  },
  get: {
    method: "GET",
    path: "/workers/sdgb/jobs/:jobId",
    pathParams: c.type<{ jobId: string }>(),
    responses: { 200: SdgbJobResponseSchema, 404: c.type<{ error: string }>() },
  },
  patch: {
    method: "PATCH",
    path: "/workers/sdgb/jobs/:jobId",
    pathParams: c.type<{ jobId: string }>(),
    body: SdgbJobPatchBodySchema,
    responses: { 200: SdgbJobResponseSchema, 404: c.type<{ error: string }>() },
  },
});
