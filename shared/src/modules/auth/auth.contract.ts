import { initContract } from '@ts-rest/core';

import {
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
});
