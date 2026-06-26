import { initContract } from "@ts-rest/core";
import { z } from "zod";

import {
  LoginByQrBodySchema,
  LoginByQrResponseSchema,
  LoginRequestBodySchema,
  LoginRequestResponseSchema,
  LoginRequestVerifyResponseSchema,
  LoginStatusQuerySchema,
  LoginStatusResponseSchema,
  PasswordLoginBodySchema,
  TokenLoginResponseSchema,
} from "./auth.schema";

const c = initContract();

export const authContract = c.router({
  loginRequest: {
    method: "POST",
    path: "/auth/login-requests",
    body: LoginRequestBodySchema,
    responses: { 201: LoginRequestResponseSchema },
  },
  loginStatus: {
    method: "GET",
    path: "/auth/login-requests/:jobId",
    pathParams: LoginStatusQuerySchema,
    responses: { 200: LoginStatusResponseSchema },
  },
  verifyLoginRequest: {
    method: "POST",
    path: "/auth/login-requests/:jobId/verify",
    pathParams: c.type<{ jobId: string }>(),
    body: c.noBody(),
    responses: { 200: LoginRequestVerifyResponseSchema },
  },
  loginByQr: {
    method: "POST",
    path: "/auth/qr-login",
    body: LoginByQrBodySchema,
    responses: {
      201: LoginByQrResponseSchema,
      400: c.type<{ error: string }>(),
      404: c.type<{ error: string }>(),
      409: c.type<{ error: string }>(),
    },
  },
  pollLoginByQr: {
    method: "GET",
    path: "/auth/qr-login/:attemptId",
    pathParams: c.type<{ attemptId: string }>(),
    responses: {
      200: z.unknown(),
      400: c.type<{ error: string }>(),
    },
  },
  passwordLogin: {
    method: "POST",
    path: "/auth/password-login",
    body: PasswordLoginBodySchema,
    responses: {
      200: TokenLoginResponseSchema,
      400: c.type<{ error: string }>(),
      401: c.type<{ error: string }>(),
    },
  },
});
