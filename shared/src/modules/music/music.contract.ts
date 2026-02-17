import { initContract } from '@ts-rest/core';

import {
  MusicListSchema,
  MusicSourceResponseSchema,
  MusicSyncResponseSchema,
  SetMusicSourceBodySchema,
} from './music.schema';

const c = initContract();

export const musicContract = c.router({
  listAll: {
    method: 'GET',
    path: '/music',
    responses: { 200: MusicListSchema },
  },
  forceSync: {
    method: 'POST',
    path: '/music/sync',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: c.noBody(),
    responses: { 201: MusicSyncResponseSchema },
  },
  getDataSource: {
    method: 'GET',
    path: '/music/source',
    responses: { 200: MusicSourceResponseSchema },
  },
  setDataSource: {
    method: 'POST',
    path: '/music/source',
    headers: c.type<{ 'x-admin-password': string }>(),
    body: SetMusicSourceBodySchema,
    responses: {
      201: MusicSourceResponseSchema.extend({
        ok: MusicSyncResponseSchema.shape.ok,
      }),
    },
  },
});
