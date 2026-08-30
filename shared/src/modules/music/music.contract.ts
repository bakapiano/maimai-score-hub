import { initContract } from "@ts-rest/core";

import {
  MusicAliasListResponseSchema,
  MusicAliasSyncResponseSchema,
  MusicListSchema,
  MusicSyncResponseSchema,
} from "./music.schema";

const c = initContract();

export const musicContract = c.router({
  listAll: {
    method: "GET",
    path: "/catalog/music",
    responses: { 200: MusicListSchema },
  },
  listAliases: {
    method: "GET",
    path: "/catalog/music/aliases",
    responses: { 200: MusicAliasListResponseSchema },
  },
  forceSync: {
    method: "POST",
    path: "/admin/catalog/music/sync",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: { 201: MusicSyncResponseSchema },
  },
  forceAliasSync: {
    method: "POST",
    path: "/admin/catalog/aliases/sync",
    headers: c.type<{ "x-api-secret": string }>(),
    body: c.noBody(),
    responses: { 201: MusicAliasSyncResponseSchema },
  },
});
