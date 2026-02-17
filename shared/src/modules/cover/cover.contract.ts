import { initContract } from '@ts-rest/core';

const c = initContract();

export const coverContract = c.router({
  getCoverBySongId: {
    method: 'GET',
    path: '/cover/:songId',
    pathParams: c.type<{ songId: string }>(),
    responses: {
      200: c.otherResponse({
        contentType: 'image/jpeg',
        body: c.type<Blob>(),
      }),
      404: c.type<{ message: string }>(),
    },
  },
  getCoverBySongIdJpg: {
    method: 'GET',
    path: '/cover/:songId.jpg',
    pathParams: c.type<{ songId: string }>(),
    responses: {
      200: c.otherResponse({
        contentType: 'image/jpeg',
        body: c.type<Blob>(),
      }),
      404: c.type<{ message: string }>(),
    },
  },
  backfillVariants: {
    method: 'POST',
    path: '/cover/backfill-variants',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: {
      201: c.type<{
        total: number;
        saved: number;
        skipped: number;
        failed: number;
      }>(),
    },
  },
});
