import { initContract } from '@ts-rest/core';
import { z } from 'zod';

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
  ReportBotStatusBodySchema,
  SearchJobsQuerySchema,
  SearchJobsResponseSchema,
  UpdateBotCabinetUserIdBodySchema,
  UpdateBotRemarkBodySchema,
} from './admin.schema';

const c = initContract();

export const adminContract = c.router({
  getStats: {
    method: 'GET',
    path: '/admin/stats',
    headers: c.type<{ 'x-admin-password': string }>(),
    responses: { 200: AdminStatsSchema },
  },
  getJobStats: {
    method: 'GET',
    path: '/admin/job-stats',
    headers: c.type<{ 'x-admin-password': string }>(),
    responses: { 200: JobStatsSchema },
  },
  getAutoUpdateMetrics: {
    method: 'GET',
    path: '/admin/auto-update-metrics',
    headers: c.type<{ 'x-admin-password': string }>(),
    query: z.object({ window: z.enum(['24h', '7d']).optional() }),
    responses: { 200: AutoUpdateMetricsSchema },
  },
  getJobTrend: {
    method: 'GET',
    path: '/admin/job-trend',
    headers: c.type<{ 'x-admin-password': string }>(),
    query: z.object({ hours: z.string().optional() }),
    responses: { 200: JobTrendSchema },
  },
  getJobErrorStats: {
    method: 'GET',
    path: '/admin/job-error-stats',
    headers: c.type<{ 'x-admin-password': string }>(),
    responses: { 200: JobErrorStatsSchema },
  },
  searchJobs: {
    method: 'GET',
    path: '/admin/jobs',
    headers: c.type<{ 'x-admin-password': string }>(),
    query: SearchJobsQuerySchema,
    responses: { 200: SearchJobsResponseSchema },
  },
  getAllUsers: {
    method: 'GET',
    path: '/admin/users',
    headers: c.type<{ 'x-admin-password': string }>(),
    responses: { 200: AdminUsersSchema },
  },
  getActiveJobs: {
    method: 'GET',
    path: '/admin/active-jobs',
    headers: c.type<{ 'x-admin-password': string }>(),
    responses: { 200: ActiveJobsSchema },
  },
  reportBotStatus: {
    method: 'POST',
    path: '/admin/bot-status',
    body: ReportBotStatusBodySchema,
    responses: { 201: c.type<{ ok: true }>() },
  },
  getBotStatus: {
    method: 'GET',
    path: '/admin/bot-status',
    headers: c.type<{ 'x-admin-password': string }>(),
    responses: { 200: z.array(BotStatusItemSchema) },
  },
  updateBotRemark: {
    method: 'PATCH',
    path: '/admin/bot-status/:friendCode/remark',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: UpdateBotRemarkBodySchema,
    responses: { 200: c.type<{ ok: true }>() },
  },
  updateBotCabinetUserId: {
    method: 'PATCH',
    path: '/admin/bot-status/:friendCode/cabinet-user-id',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: UpdateBotCabinetUserIdBodySchema,
    responses: { 200: c.type<{ ok: true }>() },
  },
  getJobApiLogs: {
    method: 'GET',
    path: '/admin/jobs/:jobId/api-logs',
    headers: c.type<{ 'x-admin-password': string }>(),
    pathParams: c.type<{ jobId: string }>(),
    responses: { 200: JobApiLogsSchema },
  },
  syncCovers: {
    method: 'POST',
    path: '/admin/sync-covers',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  forceSyncCovers: {
    method: 'POST',
    path: '/admin/force-sync-covers',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  syncMusic: {
    method: 'POST',
    path: '/admin/sync-music',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  triggerIdleUpdate: {
    method: 'POST',
    path: '/admin/trigger-idle-update',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: { 201: c.type<{ ok: true } & Record<string, unknown>>() },
  },
  cleanupJobs: {
    method: 'POST',
    path: '/admin/cleanup-jobs',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: {
      201: c.type<{ ok: true; deletedCount: number }>(),
    },
  },
});
