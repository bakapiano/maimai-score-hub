import { initContract } from "@ts-rest/core";
import { z } from "zod";

import {
  ActiveJobsSchema,
  AdminStatsSchema,
  AdminUsersSchema,
  BotStatusItemSchema,
  JobErrorStatsSchema,
  JobStatsSchema,
  JobTrendSchema,
  HistoryRowsSchema,
  HistoryLogWorkersSchema,
  JobDebugSchema,
  ObservabilityStatusSchema,
  RealtimeOverviewSchema,
  RealtimeWorkerGroupsSchema,
  ReportBotStatusBodySchema,
  SearchJobsQuerySchema,
  SearchJobsResponseSchema,
  UpdateBotCabinetUserIdBodySchema,
  UpdateBotRemarkBodySchema,
} from "./admin.schema";

const c = initContract();

export const adminContract = c.router({
  getStats: {
    method: "GET",
    path: "/admin/dashboard/stats",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: AdminStatsSchema },
  },
  getJobStats: {
    method: "GET",
    path: "/admin/dashboard/job-stats",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: JobStatsSchema },
  },
  getJobTrend: {
    method: "GET",
    path: "/admin/dashboard/job-trend",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({ hours: z.string().optional() }),
    responses: { 200: JobTrendSchema },
  },
  getJobErrorStats: {
    method: "GET",
    path: "/admin/dashboard/job-error-stats",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: JobErrorStatsSchema },
  },
  searchJobs: {
    method: "GET",
    path: "/admin/dxnet-jobs",
    headers: c.type<{ "x-api-secret": string }>(),
    query: SearchJobsQuerySchema,
    responses: { 200: SearchJobsResponseSchema },
  },
  getAllUsers: {
    method: "GET",
    path: "/admin/users",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: AdminUsersSchema },
  },
  getActiveJobs: {
    method: "GET",
    path: "/admin/dxnet-jobs/active",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: ActiveJobsSchema },
  },
  reportBotStatus: {
    method: "POST",
    path: "/workers/bots/status",
    body: ReportBotStatusBodySchema,
    responses: { 201: c.type<{ ok: true }>() },
  },
  getBotStatus: {
    method: "GET",
    path: "/admin/bots",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: z.array(BotStatusItemSchema) },
  },
  updateBotRemark: {
    method: "PATCH",
    path: "/admin/bots/:friendCode/remark",
    headers: c.type<{ "x-api-secret": string }>(),
    body: UpdateBotRemarkBodySchema,
    responses: { 200: c.type<{ ok: true }>() },
  },
  updateBotCabinetUserId: {
    method: "PATCH",
    path: "/admin/bots/:friendCode/cabinet-user-id",
    headers: c.type<{ "x-api-secret": string }>(),
    body: UpdateBotCabinetUserIdBodySchema,
    responses: { 200: c.type<{ ok: true }>() },
  },
  removeBot: {
    method: "DELETE",
    path: "/admin/bots/:friendCode",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: {
      200: c.type<{
        ok: true;
        botStatusDeleted: number;
      }>(),
    },
  },
  syncCovers: {
    method: "POST",
    path: "/admin/catalog/covers/sync",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  forceSyncCovers: {
    method: "POST",
    path: "/admin/catalog/covers/force-sync",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  syncMusic: {
    method: "POST",
    path: "/admin/catalog/music/sync",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  cleanupJobs: {
    method: "POST",
    path: "/admin/dxnet-jobs/cleanup",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: {
      201: c.type<{ ok: true; deletedCount: number }>(),
    },
  },
  getObservabilityStatus: {
    method: "GET",
    path: "/admin/observability/status",
    headers: c.type<{ "x-api-secret": string }>(),
    responses: { 200: ObservabilityStatusSchema },
  },
  getRealtimeOverview: {
    method: "GET",
    path: "/admin/realtime/overview",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      recentMinutes: z.string().optional(),
    }),
    responses: { 200: RealtimeOverviewSchema },
  },
  getRealtimeWorkerGroups: {
    method: "GET",
    path: "/admin/realtime/worker-groups",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      window: z.enum(["15m", "1h", "6h", "24h"]).optional(),
    }),
    responses: { 200: RealtimeWorkerGroupsSchema },
  },
  getHistoryApi: {
    method: "GET",
    path: "/admin/history/api",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      window: z.enum(["24h", "7d", "30d"]).optional(),
    }),
    responses: { 200: HistoryRowsSchema },
  },
  getHistoryRum: {
    method: "GET",
    path: "/admin/history/rum",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      window: z.enum(["24h", "7d", "30d"]).optional(),
    }),
    responses: { 200: HistoryRowsSchema },
  },
  getHistoryAnalytics: {
    method: "GET",
    path: "/admin/history/analytics",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      window: z.enum(["24h", "7d", "30d"]).optional(),
    }),
    responses: { 200: HistoryRowsSchema },
  },
  getHistoryWorkers: {
    method: "GET",
    path: "/admin/history/workers",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      window: z.enum(["24h", "7d", "30d"]).optional(),
    }),
    responses: { 200: HistoryRowsSchema },
  },
  getHistoryLogs: {
    method: "GET",
    path: "/admin/history/logs",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      service: z.string().optional(),
      workerKind: z.enum(["backend", "dxnet", "sdgb", "prober_export"]).optional(),
      workerId: z.string().optional(),
      level: z.string().optional(),
      jobId: z.string().optional(),
      q: z.string().optional(),
      sinceMinutes: z.string().optional(),
      limit: z.string().optional(),
    }),
    responses: { 200: HistoryRowsSchema },
  },
  getHistoryLogWorkers: {
    method: "GET",
    path: "/admin/history/log-workers",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({
      env: z.enum(["prod", "dev"]).optional(),
      sinceMinutes: z.string().optional(),
    }),
    responses: { 200: HistoryLogWorkersSchema },
  },
  getJobDebug: {
    method: "GET",
    path: "/admin/jobs/:jobId/debug",
    headers: c.type<{ "x-api-secret": string }>(),
    pathParams: c.type<{ jobId: string }>(),
    query: z.object({ env: z.enum(["prod", "dev"]).optional() }),
    responses: { 200: JobDebugSchema },
  },
});
