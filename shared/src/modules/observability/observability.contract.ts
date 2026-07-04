import { initContract } from "@ts-rest/core";
import { z } from "zod";

import {
  AnalyticsBatchBodySchema,
  ExternalApiCallBatchBodySchema,
  ObservabilityIngestResponseSchema,
  RumBatchBodySchema,
  WorkerStructuredLogBatchBodySchema,
} from "./observability.schema";

const c = initContract();

export const observabilityContract = c.router({
  ingestRum: {
    method: "POST",
    path: "/observability/rum",
    body: RumBatchBodySchema,
    responses: { 202: ObservabilityIngestResponseSchema },
  },
  ingestEvents: {
    method: "POST",
    path: "/observability/events",
    body: AnalyticsBatchBodySchema,
    responses: { 202: ObservabilityIngestResponseSchema },
  },
  ingestWorkerLogs: {
    method: "POST",
    path: "/workers/logs/:kind/batches",
    headers: c.type<{ "x-api-secret": string }>(),
    pathParams: z.object({ kind: z.enum(["dxnet", "sdgb"]) }),
    body: WorkerStructuredLogBatchBodySchema,
    responses: { 201: ObservabilityIngestResponseSchema },
  },
  ingestExternalApiCalls: {
    method: "POST",
    path: "/workers/dxnet/jobs/:jobId/api-calls",
    headers: c.type<{ "x-api-secret": string }>(),
    pathParams: z.object({ jobId: z.string() }),
    body: ExternalApiCallBatchBodySchema,
    responses: { 201: ObservabilityIngestResponseSchema },
  },
  ingestWorkerExternalApiCalls: {
    method: "POST",
    path: "/workers/:kind/external-api-calls",
    headers: c.type<{ "x-api-secret": string }>(),
    pathParams: z.object({ kind: z.string() }),
    body: ExternalApiCallBatchBodySchema,
    responses: { 201: ObservabilityIngestResponseSchema },
  },
});
