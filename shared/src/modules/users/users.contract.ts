import { initContract } from '@ts-rest/core';

import {
  BindCabinetQrBodySchema,
  BindCabinetQrResponseSchema,
  DivingFishTokenBodySchema,
  DivingFishTokenResponseSchema,
  IdleUpdateDisableResponseSchema,
  IdleUpdateEnableResponseSchema,
  IdleUpdateStatusSchema,
  SetAutoUpdateBodySchema,
  SetAutoUpdateResponseSchema,
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
  /**
   * Bind a cabinet (sdgb) userId to this account by scanning the player's
   * physical-card QR. The endpoint accepts either JSON `{qrCode}` or a
   * multipart upload with field `image` — see BindCabinetQrBodySchema.
   * The body schema only describes the JSON shape; multipart is handled
   * at the controller layer.
   */
  bindCabinetQr: {
    method: 'POST',
    path: '/users/cabinet/bind-qr',
    headers: c.type<{ authorization: string }>(),
    body: BindCabinetQrBodySchema,
    responses: {
      201: BindCabinetQrResponseSchema,
      409: c.type<{ error: string }>(),
      400: c.type<{ error: string }>(),
    },
  },
  setAutoUpdate: {
    method: 'POST',
    path: '/users/cabinet/auto-update',
    headers: c.type<{ authorization: string }>(),
    body: SetAutoUpdateBodySchema,
    responses: {
      201: SetAutoUpdateResponseSchema,
      400: c.type<{ error: string }>(),
    },
  },
});
