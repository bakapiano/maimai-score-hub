import {
  TempCacheBodySchema,
  TempCacheResponseSchema,
} from "./job-extra.schema";
import {
  JobByFriendCodeActiveResponseSchema,
  JobCreateBodySchema,
  JobCreateResponseSchema,
  JobFriendshipStatusResponseSchema,
  JobPatchBodySchema,
  JobResponseSchema,
  JobVerifyResponseSchema,
} from "./job.schema";

import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const jobContract = c.router({
  create: {
    method: "POST",
    path: "/me/dxnet-jobs",
    headers: z.object({ authorization: z.string() }),
    body: JobCreateBodySchema,
    responses: {
      201: JobCreateResponseSchema,
      400: z.object({
        code: z.string().optional(),
        message: z.union([z.string(), z.array(z.string())]).optional(),
        recommendedBotFriendCode: z.string().nullable().optional(),
      }),
    },
  },
  getById: {
    method: "GET",
    path: "/me/dxnet-jobs/:jobId",
    headers: z.object({ authorization: z.string() }),
    pathParams: z.object({ jobId: z.string() }),
    responses: {
      200: JobResponseSchema,
    },
  },
  getActiveByFriendCode: {
    method: "GET",
    path: "/me/dxnet-jobs/active",
    headers: z.object({ authorization: z.string() }),
    responses: {
      200: JobByFriendCodeActiveResponseSchema,
    },
  },
  getFriendshipStatus: {
    method: "GET",
    path: "/me/dxnet-jobs/friendship",
    headers: z.object({ authorization: z.string() }),
    responses: {
      200: JobFriendshipStatusResponseSchema,
    },
  },
  verify: {
    method: "POST",
    path: "/me/dxnet-jobs/:jobId/verify",
    headers: z.object({ authorization: z.string() }),
    pathParams: z.object({ jobId: z.string() }),
    body: z.undefined(),
    responses: {
      200: JobVerifyResponseSchema,
    },
  },
  getWorkerJob: {
    method: "GET",
    path: "/workers/dxnet/jobs/:jobId",
    pathParams: z.object({ jobId: z.string() }),
    responses: {
      200: JobResponseSchema,
    },
  },
  patch: {
    method: "PATCH",
    path: "/workers/dxnet/jobs/:jobId",
    pathParams: z.object({ jobId: z.string() }),
    body: JobPatchBodySchema,
    responses: {
      200: JobResponseSchema,
    },
  },
  getActiveByBot: {
    method: "GET",
    path: "/workers/dxnet/bots/:botUserFriendCode/active-friend-codes",
    pathParams: z.object({ botUserFriendCode: z.string() }),
    responses: {
      200: z.array(z.string()),
    },
  },
  getRunningQrLoginRivalNames: {
    method: "GET",
    path: "/workers/dxnet/qr-login/rival-names",
    responses: {
      200: z.array(z.string()),
    },
  },
  getUsersActivity: {
    method: "POST",
    path: "/workers/dxnet/users/activity",
    body: z.object({ friendCodes: z.array(z.string()) }),
    responses: {
      200: z.array(
        z.object({
          friendCode: z.string(),
          lastActiveAt: z.string().nullable(),
          cabinetUserId: z.number().nullable(),
        }),
      ),
    },
  },
  getTempCache: {
    method: "GET",
    path: "/workers/dxnet/jobs/:jobId/cache/:diff/:type",
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
    method: "PUT",
    path: "/workers/dxnet/jobs/:jobId/cache/:diff/:type",
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
});
