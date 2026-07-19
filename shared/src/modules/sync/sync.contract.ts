import { initContract } from "@ts-rest/core";

import {
  CabinetScoreActiveJobSchema,
  CabinetScoreJobCreateBodySchema,
  CabinetScoreJobCreateResponseSchema,
  CabinetScoreJobSchema,
  LastSyncSchema,
  ProberExportCreateResponseSchema,
  ProberExportJobSchema,
  ProberExportListResponseSchema,
  ScoreChangeHistoryQuerySchema,
  ScoreChangeHistoryResponseSchema,
  ScoreHistoryFeedQuerySchema,
  ScoreHistoryFeedResponseSchema,
  ScoreHistoryCalendarQuerySchema,
  ScoreHistoryCalendarResponseSchema,
} from "./sync.schema";

const c = initContract();

export const syncContract = c.router({
  createCabinetScoreJob: {
    method: "POST",
    path: "/me/cabinet-score-jobs",
    headers: c.type<{ authorization: string }>(),
    body: CabinetScoreJobCreateBodySchema,
    responses: {
      202: CabinetScoreJobCreateResponseSchema,
      400: c.type<{ code?: string; message?: string }>(),
      409: c.type<{ code?: string; message?: string; retryAfter?: string }>(),
    },
  },
  getActiveCabinetScoreJob: {
    method: "GET",
    path: "/me/cabinet-score-jobs/active",
    headers: c.type<{ authorization: string }>(),
    responses: { 200: CabinetScoreActiveJobSchema },
  },
  getCabinetScoreJob: {
    method: "GET",
    path: "/me/cabinet-score-jobs/:jobId",
    headers: c.type<{ authorization: string }>(),
    pathParams: c.type<{ jobId: string }>(),
    responses: { 200: CabinetScoreJobSchema },
  },
  latest: {
    method: "GET",
    path: "/me/sync/latest",
    headers: c.type<{ authorization: string }>(),
    responses: { 200: LastSyncSchema.nullable() },
  },
  exportToDivingFish: {
    method: "POST",
    path: "/me/sync/latest/exports/diving-fish",
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: ProberExportCreateResponseSchema },
  },
  exportToLxns: {
    method: "POST",
    path: "/me/sync/latest/exports/lxns",
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: ProberExportCreateResponseSchema },
  },
  getProberExportJob: {
    method: "GET",
    path: "/me/sync/prober-export-jobs/:exportJobId",
    headers: c.type<{ authorization: string }>(),
    pathParams: c.type<{ exportJobId: string }>(),
    responses: { 200: ProberExportJobSchema },
  },
  listProberExportJobs: {
    method: "GET",
    path: "/me/sync/prober-export-jobs",
    headers: c.type<{ authorization: string }>(),
    query: c.type<{ limit?: string }>(),
    responses: { 200: ProberExportListResponseSchema },
  },
  getScoreChangeHistory: {
    method: "GET",
    path: "/me/score-changes",
    headers: c.type<{ authorization: string }>(),
    query: ScoreChangeHistoryQuerySchema,
    responses: { 200: ScoreChangeHistoryResponseSchema },
  },
  listScoreHistory: {
    method: "GET",
    path: "/me/score-history",
    headers: c.type<{ authorization: string }>(),
    query: ScoreHistoryFeedQuerySchema,
    responses: { 200: ScoreHistoryFeedResponseSchema },
  },
  getScoreHistoryCalendar: {
    method: "GET",
    path: "/me/score-history/calendar",
    headers: c.type<{ authorization: string }>(),
    query: ScoreHistoryCalendarQuerySchema,
    responses: { 200: ScoreHistoryCalendarResponseSchema },
  },
});
