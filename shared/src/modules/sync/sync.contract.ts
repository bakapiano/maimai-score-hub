import { initContract } from "@ts-rest/core";

import { ExportResultSchema, LastSyncSchema } from "./sync.schema";

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
    responses: { 201: ExportResultSchema },
  },
  exportToLxns: {
    method: "POST",
    path: "/me/sync/latest/exports/lxns",
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: ExportResultSchema },
  },
});
