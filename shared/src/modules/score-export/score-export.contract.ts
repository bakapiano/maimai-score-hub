import { initContract } from "@ts-rest/core";

const c = initContract();

export const scoreExportContract = c.router({
  best50: {
    method: "GET",
    path: "/me/score-exports/best50",
    responses: {
      200: c.otherResponse({
        contentType: "image/png",
        body: c.type<Blob>(),
      }),
    },
  },
  level: {
    method: "GET",
    path: "/me/score-exports/level",
    query: c.type<{ level?: string }>(),
    responses: {
      200: c.otherResponse({
        contentType: "image/png",
        body: c.type<Blob>(),
      }),
    },
  },
  version: {
    method: "GET",
    path: "/me/score-exports/version",
    query: c.type<{ version?: string; minLevel?: string; plan?: string }>(),
    responses: {
      200: c.otherResponse({
        contentType: "image/png",
        body: c.type<Blob>(),
      }),
    },
  },
});
