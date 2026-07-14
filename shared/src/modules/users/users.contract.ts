import { initContract } from "@ts-rest/core";

import {
  BindCabinetQrBodySchema,
  BindCabinetQrMismatchSchema,
  BindCabinetQrResponseSchema,
  DivingFishTokenBodySchema,
  DivingFishTokenResponseSchema,
  DeletePasskeyBodySchema,
  PasskeyRegistrationOptionsBodySchema,
  PasskeyRegistrationOptionsResponseSchema,
  PasskeyRegistrationVerifyBodySchema,
  PasskeySummarySchema,
  RenamePasskeyBodySchema,
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
  listPasskeys: {
    method: "GET",
    path: "/me/passkeys",
    headers: c.type<{ authorization: string }>(),
    responses: {
      200: PasskeySummarySchema.array(),
      401: c.type<{ error: string }>(),
    },
  },
  createPasskeyOptions: {
    method: "POST",
    path: "/me/passkeys/registration/options",
    headers: c.type<{ authorization: string }>(),
    body: PasskeyRegistrationOptionsBodySchema,
    responses: {
      200: PasskeyRegistrationOptionsResponseSchema,
      403: c.type<{ code: string; message: string }>(),
      409: c.type<{ code: string; message: string }>(),
      429: c.type<{ code: string; message: string }>(),
    },
  },
  verifyPasskeyRegistration: {
    method: "POST",
    path: "/me/passkeys/registration/verify",
    headers: c.type<{ authorization: string }>(),
    body: PasskeyRegistrationVerifyBodySchema,
    responses: {
      201: PasskeySummarySchema,
      400: c.type<{ code: string; message: string }>(),
      409: c.type<{ code: string; message: string }>(),
    },
  },
  renamePasskey: {
    method: "PATCH",
    path: "/me/passkeys/:id",
    pathParams: c.type<{ id: string }>(),
    headers: c.type<{ authorization: string }>(),
    body: RenamePasskeyBodySchema,
    responses: {
      200: PasskeySummarySchema,
      404: c.type<{ code: string; message: string }>(),
    },
  },
  deletePasskey: {
    method: "POST",
    path: "/me/passkeys/:id/delete",
    pathParams: c.type<{ id: string }>(),
    headers: c.type<{ authorization: string }>(),
    body: DeletePasskeyBodySchema,
    responses: {
      200: c.type<{ ok: true }>(),
      403: c.type<{ code: string; message: string }>(),
      404: c.type<{ code: string; message: string }>(),
      429: c.type<{ code: string; message: string }>(),
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
      409: BindCabinetQrMismatchSchema,
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
        deleted: {
          user: number;
          syncs: number;
          jobs: number;
          passkeys: number;
        };
      }>(),
    },
  },
});
