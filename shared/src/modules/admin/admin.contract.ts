import { initContract } from "@ts-rest/core";
import { z } from "zod";

import {
  ActiveJobsSchema,
  AdminStatsSchema,
  AdminUsersSchema,
  AutoUpdateMetricsSchema,
  BotStatusItemSchema,
  JobApiLogsSchema,
  JobErrorStatsSchema,
  JobStatsSchema,
  JobTrendSchema,
  ProberExportMetricsSchema,
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
  getAutoUpdateMetrics: {
    method: "GET",
    path: "/admin/dashboard/auto-update-metrics",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({ window: z.enum(["24h", "7d"]).optional() }),
    responses: { 200: AutoUpdateMetricsSchema },
  },
  getProberExportMetrics: {
    method: "GET",
    path: "/admin/dashboard/prober-export-metrics",
    headers: c.type<{ "x-api-secret": string }>(),
    query: z.object({ window: z.enum(["24h", "7d"]).optional() }),
    responses: { 200: ProberExportMetricsSchema },
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
        snapshotDeleted: number;
      }>(),
    },
  },
  getJobApiLogs: {
    method: "GET",
    path: "/admin/dxnet-jobs/:jobId/api-logs",
    headers: c.type<{ "x-api-secret": string }>(),
    pathParams: c.type<{ jobId: string }>(),
    responses: { 200: JobApiLogsSchema },
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
});
