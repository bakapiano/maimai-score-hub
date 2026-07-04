import { z } from "zod";

const AttrValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const ObservabilityAttrsSchema = z.record(
  z.union([AttrValueSchema, z.array(AttrValueSchema)]),
);

export const ObservabilityIngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

export const RumEventSchema = z.object({
  ts: z.string().optional(),
  sessionId: z.string().optional(),
  friendCode: z.string().optional(),
  routeTemplate: z.string(),
  pageUrlHash: z.string().optional(),
  referrerHash: z.string().optional(),
  browser: z.string().optional(),
  os: z.string().optional(),
  deviceType: z.string().optional(),
  fcpMs: z.number().nonnegative().optional(),
  lcpMs: z.number().nonnegative().optional(),
  inpMs: z.number().nonnegative().optional(),
  cls: z.number().nonnegative().optional(),
  ttfbMs: z.number().nonnegative().optional(),
  loadMs: z.number().nonnegative().optional(),
  apiWaitMs: z.number().nonnegative().optional(),
  jsError: z.boolean().optional(),
  errorName: z.string().optional(),
  errorMessageHash: z.string().optional(),
  traceId: z.string().optional(),
  attrs: ObservabilityAttrsSchema.optional(),
});

export const RumBatchBodySchema = z.object({
  events: z.array(RumEventSchema).max(200),
});

export const AnalyticsEventSchema = z.object({
  ts: z.string().optional(),
  eventName: z.string().min(1).max(128),
  friendCode: z.string().optional(),
  sessionId: z.string().optional(),
  routeTemplate: z.string().optional(),
  source: z.string().optional(),
  appVersion: z.string().optional(),
  properties: ObservabilityAttrsSchema.optional(),
});

export const AnalyticsBatchBodySchema = z.object({
  events: z.array(AnalyticsEventSchema).max(200),
});

export const WorkerStructuredLogEntrySchema = z.object({
  ts: z.string().optional(),
  level: z.enum(["log", "warn", "error", "debug", "info"]).optional(),
  message: z.string(),
  traceId: z.string().optional(),
  requestId: z.string().optional(),
  jobId: z.string().optional(),
  workerId: z.string().optional(),
  botFriendCode: z.string().optional(),
  eventName: z.string().optional(),
  errorClass: z.string().optional(),
  attrs: ObservabilityAttrsSchema.optional(),
});

export const WorkerStructuredLogBatchBodySchema = z.object({
  workerId: z.string().optional(),
  entries: z.array(WorkerStructuredLogEntrySchema).max(1000),
});

export const ExternalApiCallEntrySchema = z.object({
  ts: z.string().optional(),
  traceId: z.string().optional(),
  jobId: z.string().optional(),
  workerKind: z.string().optional(),
  workerId: z.string().optional(),
  botFriendCode: z.string().optional(),
  target: z.string().min(1),
  apiGroup: z.string().min(1),
  method: z.string().min(1),
  urlGroup: z.string().min(1),
  statusCode: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  bodySize: z.number().int().nonnegative().nullable().optional(),
  bodyHash: z.string().optional(),
  artifactKey: z.string().nullable().optional(),
  errorClass: z.string().optional(),
  attrs: ObservabilityAttrsSchema.optional(),
});

export const ExternalApiCallBatchBodySchema = z.object({
  calls: z.array(ExternalApiCallEntrySchema).max(1000),
});

export type RumEvent = z.infer<typeof RumEventSchema>;
export type RumBatchBody = z.infer<typeof RumBatchBodySchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsBatchBody = z.infer<typeof AnalyticsBatchBodySchema>;
export type WorkerStructuredLogEntry = z.infer<
  typeof WorkerStructuredLogEntrySchema
>;
export type WorkerStructuredLogBatchBody = z.infer<
  typeof WorkerStructuredLogBatchBodySchema
>;
export type ExternalApiCallEntry = z.infer<typeof ExternalApiCallEntrySchema>;
export type ExternalApiCallBatchBody = z.infer<
  typeof ExternalApiCallBatchBodySchema
>;
