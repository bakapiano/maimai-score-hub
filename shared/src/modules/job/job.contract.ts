import {
  AddApiLogsBodySchema,
  TempCacheBodySchema,
  TempCacheResponseSchema,
} from "./job-extra.schema";
import {
  JobByFriendCodeActiveResponseSchema,
  JobCreateBodySchema,
  JobCreateResponseSchema,
  JobNextBodySchema,
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
  next: {
    method: "POST",
    path: "/workers/dxnet/jobs/next",
    body: JobNextBodySchema,
    responses: {
      200: JobResponseSchema,
      204: z.undefined(),
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
  getUsersActivity: {
    method: "POST",
    path: "/workers/dxnet/users/activity",
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
  getExistingUsers: {
    method: "POST",
    path: "/workers/dxnet/users/existence",
    body: z.object({ friendCodes: z.array(z.string()) }),
    responses: {
      200: z.object({ existingFriendCodes: z.array(z.string()) }),
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
  addApiLogs: {
    method: "POST",
    path: "/workers/dxnet/jobs/:jobId/api-logs",
    pathParams: z.object({ jobId: z.string() }),
    body: AddApiLogsBodySchema,
    responses: {
      201: z.object({ success: z.boolean() }),
    },
  },
});
