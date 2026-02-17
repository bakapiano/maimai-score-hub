import { initContract } from '@ts-rest/core';

import {
  DivingFishTokenBodySchema,
  DivingFishTokenResponseSchema,
  IdleUpdateDisableResponseSchema,
  IdleUpdateEnableResponseSchema,
  IdleUpdateStatusSchema,
  UpdateProfileBodySchema,
  UserProfileSchema,
} from './users.schema';

const c = initContract();

export const usersContract = c.router({
  profile: {
    method: 'GET',
    path: '/users/profile',
    headers: c.type<{ authorization: string }>(),
    responses: { 200: UserProfileSchema },
  },
  updateProfile: {
    method: 'PATCH',
    path: '/users/profile',
    headers: c.type<{ authorization: string }>(),
    body: UpdateProfileBodySchema,
    responses: { 200: UserProfileSchema },
  },
  getDivingFishToken: {
    method: 'POST',
    path: '/users/diving-fish/token',
    headers: c.type<{ authorization: string }>(),
    body: DivingFishTokenBodySchema,
    responses: { 201: DivingFishTokenResponseSchema },
  },
  enableIdleUpdate: {
    method: 'POST',
    path: '/users/idle-update/enable',
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: IdleUpdateEnableResponseSchema },
  },
  disableIdleUpdate: {
    method: 'POST',
    path: '/users/idle-update/disable',
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: { 201: IdleUpdateDisableResponseSchema },
  },
  getIdleUpdateStatus: {
    method: 'GET',
    path: '/users/idle-update/status',
    headers: c.type<{ authorization: string }>(),
    responses: { 200: IdleUpdateStatusSchema },
  },
});
