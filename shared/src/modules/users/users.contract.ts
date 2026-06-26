import { initContract } from "@ts-rest/core";

import {
  BindCabinetQrBodySchema,
  BindCabinetQrResponseSchema,
  DivingFishTokenBodySchema,
  DivingFishTokenResponseSchema,
  SetAccountPasswordBodySchema,
  UpdateProfileBodySchema,
  UserProfileSchema,
} from "./users.schema";

const c = initContract();

export const usersContract = c.router({
  profile: {
    method: "GET",
    path: "/me",
    headers: c.type<{ authorization: string }>(),
    responses: { 200: UserProfileSchema },
  },
  updateProfile: {
    method: "PATCH",
    path: "/me",
    headers: c.type<{ authorization: string }>(),
    body: UpdateProfileBodySchema,
    responses: { 200: UserProfileSchema },
  },
  setPassword: {
    method: "PUT",
    path: "/me/password",
    headers: c.type<{ authorization: string }>(),
    body: SetAccountPasswordBodySchema,
    responses: {
      200: UserProfileSchema,
      400: c.type<{ error: string }>(),
      401: c.type<{ error: string }>(),
      409: c.type<{ error: string }>(),
    },
  },
  getDivingFishToken: {
    method: "POST",
    path: "/me/prober-tokens/diving-fish",
    headers: c.type<{ authorization: string }>(),
    body: DivingFishTokenBodySchema,
    responses: { 201: DivingFishTokenResponseSchema },
  },
  /**
   * Bind a cabinet (sdgb) userId to this account by scanning the player's
   * physical-card QR. The endpoint accepts either JSON `{qrCode}` or a
   * multipart upload with field `image` — see BindCabinetQrBodySchema.
   * The body schema only describes the JSON shape; multipart is handled
   * at the controller layer.
   */
  bindCabinetQr: {
    method: "PUT",
    path: "/me/cabinet",
    headers: c.type<{ authorization: string }>(),
    body: BindCabinetQrBodySchema,
    responses: {
      201: BindCabinetQrResponseSchema,
      409: c.type<{ error: string }>(),
      400: c.type<{ error: string }>(),
    },
  },
  unbindCabinet: {
    method: "DELETE",
    path: "/me/cabinet",
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: {
      200: BindCabinetQrResponseSchema,
      400: c.type<{ error: string }>(),
    },
  },
  deleteMe: {
    method: "DELETE",
    path: "/me",
    headers: c.type<{ authorization: string }>(),
    body: c.noBody(),
    responses: {
      200: c.type<{
        ok: true;
        friendCode: string;
        deleted: { user: number; syncs: number; jobs: number };
      }>(),
    },
  },
});
