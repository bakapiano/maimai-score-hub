import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const ScoreHistoryExportQuerySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start: z.coerce.number().int().min(0).max(8_640_000_000_000_000),
    end: z.coerce.number().int().min(0).max(8_640_000_000_000_000),
    timeZone: z.string().trim().min(1).max(64),
    dayStartHour: z.coerce.number().int().min(0).max(23),
  })
  .strict()
  .refine((query) => query.start < query.end, {
    message: "start must be earlier than end",
  })
  .refine((query) => query.end - query.start <= 26 * 60 * 60 * 1000, {
    message: "history export range cannot exceed 26 hours",
  });

export type ScoreHistoryExportQuery = z.infer<
  typeof ScoreHistoryExportQuerySchema
>;

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
  history: {
    method: "GET",
    path: "/me/score-exports/history",
    query: ScoreHistoryExportQuerySchema,
    responses: {
      200: c.otherResponse({
        contentType: "image/png",
        body: c.type<Blob>(),
      }),
    },
  },
});
