import { initContract } from '@ts-rest/core';

import { ExportResultSchema, LastSyncSchema } from './sync.schema';

const c = initContract();

export const syncContract = c.router({
  latest: {
    method: 'GET',
    path: '/sync/latest',
    headers: c.type<{ authorization: string }>(),
    responses: { 200: LastSyncSchema.nullable() },
  },
  exportToDivingFish: {
    method: 'POST',
    path: '/sync/latest/diving-fish',
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: ExportResultSchema },
  },
  exportToLxns: {
    method: 'POST',
    path: '/sync/latest/lxns',
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: ExportResultSchema },
  },
});
