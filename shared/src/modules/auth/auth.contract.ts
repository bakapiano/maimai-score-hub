import { initContract } from '@ts-rest/core';

import {
  LoginByQrBodySchema,
  LoginByQrResponseSchema,
  LoginRequestBodySchema,
  LoginRequestResponseSchema,
  LoginStatusQuerySchema,
  LoginStatusResponseSchema,
} from './auth.schema';

const c = initContract();

export const authContract = c.router({
  loginRequest: {
    method: 'POST',
    path: '/auth/login-request',
    body: LoginRequestBodySchema,
    responses: { 201: LoginRequestResponseSchema },
  },
  loginStatus: {
    method: 'GET',
    path: '/auth/login-status',
    query: LoginStatusQuerySchema,
    responses: { 200: LoginStatusResponseSchema },
  },
  loginByQr: {
    method: 'POST',
    path: '/auth/login-by-qr',
    body: LoginByQrBodySchema,
    responses: {
      201: LoginByQrResponseSchema,
      400: c.type<{ error: string }>(),
      404: c.type<{ error: string }>(),
      409: c.type<{ error: string }>(),
    },
  },
});
