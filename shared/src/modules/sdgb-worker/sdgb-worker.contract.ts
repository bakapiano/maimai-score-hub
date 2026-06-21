import { initContract } from "@ts-rest/core";

import {
  SdgbJobNextBodySchema,
  SdgbJobPatchBodySchema,
  SdgbJobResponseSchema,
} from "./sdgb-worker.schema";

const c = initContract();

/**
 * Backend-side contract for the sdgb-worker.
 *
 * sdgb-worker is a single-concurrency PULL worker — it has no inbound HTTP
 * surface. It long-polls `next`, runs one cabinet API call, then `patch`es
 * the result. Producers inside backend enqueue via SdgbJobService directly.
 */
export const sdgbWorkerContract = c.router({
  next: {
    method: "POST",
    path: "/workers/sdgb/jobs/next",
    body: SdgbJobNextBodySchema,
    responses: {
      200: SdgbJobResponseSchema,
      204: c.noBody(),
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
