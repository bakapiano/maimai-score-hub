import { initContract } from "@ts-rest/core";

import {
  AndroidAppReleaseEnvelopeSchema,
  AndroidAppReleaseLatestQuerySchema,
  AndroidAppReleaseLatestResponseSchema,
} from "./android-app-release.schema";

const c = initContract();

export const androidAppReleaseContract = c.router({
  getLatest: {
    method: "GET",
    path: "/android/app/releases/latest",
    query: AndroidAppReleaseLatestQuerySchema,
    responses: {
      200: AndroidAppReleaseLatestResponseSchema,
    },
  },
  getManifest: {
    method: "GET",
    path: "/android/app/releases/:releaseId/manifest",
    pathParams: c.type<{ releaseId: string }>(),
    responses: {
      200: AndroidAppReleaseEnvelopeSchema,
      404: c.type<{ message: string }>(),
    },
  },
});
