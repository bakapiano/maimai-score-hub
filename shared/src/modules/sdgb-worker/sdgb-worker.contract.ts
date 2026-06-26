import { initContract } from "@ts-rest/core";

import {
  SdgbJobPatchBodySchema,
  SdgbJobResponseSchema,
} from "./sdgb-worker.schema";

const c = initContract();

/**
 * Backend-side contract for the sdgb-worker.
 *
 * sdgb-worker consumes BullMQ jobs directly, loads the Mongo row by id,
 * runs one cabinet API call, then `patch`es the result. Producers inside
 * backend enqueue via SdgbJobService directly.
 */
export const sdgbWorkerContract = c.router({
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
