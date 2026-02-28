import {
  AddApiLogsBodySchema,
  IdleUpdateMarkReadyBodySchema,
  TempCacheBodySchema,
  TempCacheResponseSchema,
} from "./job-extra.schema";
import {
  JobByFriendCodeActiveResponseSchema,
  JobCreateBodySchema,
  JobCreateResponseSchema,
  JobNextBodySchema,
  JobPatchBodySchema,
  JobRecentStatsSchema,
  JobResponseSchema,
} from "./job.schema";

import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const jobContract = c.router({
  create: {
    method: "POST",
    path: "/job/create",
    headers: z.object({ authorization: z.string() }),
    body: JobCreateBodySchema,
    responses: {
      201: JobCreateResponseSchema,
    },
  },
  getById: {
    method: "GET",
    path: "/job/:jobId",
    pathParams: z.object({ jobId: z.string() }),
    responses: {
      200: JobResponseSchema,
    },
  },
  getActiveByFriendCode: {
    method: "GET",
    path: "/job/by-friend-code/:friendCode/active",
    pathParams: z.object({ friendCode: z.string() }),
    headers: z.object({ authorization: z.string() }),
    responses: {
      200: JobByFriendCodeActiveResponseSchema,
    },
  },
  getRecentStats: {
    method: "GET",
    path: "/job/stats/recent",
    responses: {
      200: JobRecentStatsSchema,
    },
  },
  next: {
    method: "POST",
    path: "/job/next",
    body: JobNextBodySchema,
    responses: {
      200: JobResponseSchema,
      204: c.noBody(),
    },
  },
  patch: {
    method: "PATCH",
    path: "/job/:jobId",
    pathParams: z.object({ jobId: z.string() }),
    body: JobPatchBodySchema,
    responses: {
      200: JobResponseSchema,
    },
  },
  getActiveByBot: {
    method: "GET",
    path: "/job/active/:botUserFriendCode",
    pathParams: z.object({ botUserFriendCode: z.string() }),
    responses: {
      200: z.array(z.string()),
    },
  },
  markIdleUpdateReady: {
    method: "POST",
    path: "/job/idle-update/mark-ready",
    body: IdleUpdateMarkReadyBodySchema,
    responses: {
      200: z.object({ ok: z.boolean() }),
    },
  },
  getIdleUpdateFriends: {
    method: "GET",
    path: "/job/idle-update/friends/:botFriendCode",
    pathParams: z.object({ botFriendCode: z.string() }),
    responses: {
      200: z.array(z.string()),
    },
  },
  getIdleUpdateFriendsDetailed: {
    method: "GET",
    path: "/job/idle-update/friends/:botFriendCode/detailed",
    pathParams: z.object({ botFriendCode: z.string() }),
    responses: {
      200: z.array(
        z.object({
          friendCode: z.string(),
          lastActiveAt: z.string().nullable(),
        }),
      ),
    },
  },
  getUsersActivity: {
    method: "POST",
    path: "/job/users-activity",
    body: z.object({ friendCodes: z.array(z.string()) }),
    responses: {
      200: z.array(
        z.object({
          friendCode: z.string(),
          lastActiveAt: z.string().nullable(),
        }),
      ),
    },
  },
  getTempCache: {
    method: "GET",
    path: "/job/:jobId/cache/:diff/:type",
    pathParams: z.object({
      jobId: z.string(),
      diff: z.string(),
      type: z.string(),
    }),
    responses: {
      200: TempCacheResponseSchema,
    },
  },
  setTempCache: {
    method: "POST",
    path: "/job/:jobId/cache/:diff/:type",
    pathParams: z.object({
      jobId: z.string(),
      diff: z.string(),
      type: z.string(),
    }),
    body: TempCacheBodySchema,
    responses: {
      201: z.object({ success: z.boolean() }),
    },
  },
  addApiLogs: {
    method: "POST",
    path: "/job/:jobId/api-logs",
    pathParams: z.object({ jobId: z.string() }),
    body: AddApiLogsBodySchema,
    responses: {
      201: z.object({ success: z.boolean() }),
    },
  },
});
