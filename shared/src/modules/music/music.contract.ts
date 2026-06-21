import { initContract } from "@ts-rest/core";

import {
  MusicListSchema,
  MusicSourceResponseSchema,
  MusicSyncResponseSchema,
  SetMusicSourceBodySchema,
} from "./music.schema";

const c = initContract();

export const musicContract = c.router({
  listAll: {
    method: "GET",
    path: "/catalog/music",
    responses: { 200: MusicListSchema },
  },
  forceSync: {
    method: "POST",
    path: "/admin/catalog/music/sync",
    headers: c.type<{ "x-admin-password": string }>(),
    body: c.noBody(),
    responses: { 201: MusicSyncResponseSchema },
  },
  getDataSource: {
    method: "GET",
    path: "/admin/catalog/music/source",
    headers: c.type<{ "x-admin-password": string }>(),
    responses: { 200: MusicSourceResponseSchema },
  },
  setDataSource: {
    method: "PUT",
    path: "/admin/catalog/music/source",
    headers: c.type<{ "x-admin-password": string }>(),
    body: SetMusicSourceBodySchema,
    responses: {
      200: MusicSourceResponseSchema.extend({
        ok: MusicSyncResponseSchema.shape.ok,
      }),
    },
  },
});
