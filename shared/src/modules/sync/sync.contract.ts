import { initContract } from "@ts-rest/core";

import {
  LastSyncSchema,
  ProberExportCreateResponseSchema,
  ProberExportJobSchema,
  ProberExportListResponseSchema,
} from "./sync.schema";

const c = initContract();

export const syncContract = c.router({
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
});
