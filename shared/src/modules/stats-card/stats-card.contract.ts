import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();
export const StatsCardThemeSchema = z.enum(["light", "dark"]);
export type StatsCardTheme = z.infer<typeof StatsCardThemeSchema>;
export const StatsCardQuerySchema = z
  .object({
    theme: StatsCardThemeSchema.default("light"),
  })
  .strict();
export const StatsCardCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const StatsCardMutationSchema = z.object({}).strict();
export const StatsCardDisplaySchema = z
  .object({
    rating: z.boolean(),
    awakeningCount: z.boolean(),
    classRank: z.boolean(),
    courseRank: z.boolean(),
    title: z.boolean(),
  })
  .strict();
export type StatsCardDisplay = z.infer<typeof StatsCardDisplaySchema>;
export const DEFAULT_STATS_CARD_DISPLAY: Readonly<StatsCardDisplay> = {
  rating: true,
  awakeningCount: true,
  classRank: true,
  courseRank: true,
  title: true,
};
export const StatsCardDisplayPatchSchema =
  StatsCardDisplaySchema.partial().refine(
    (value) => Object.keys(value).length > 0,
    { message: "Select at least one field" },
  );
export type StatsCardDisplayPatch = z.infer<typeof StatsCardDisplayPatchSchema>;
export const StatsCardStateSchema = z.object({
  enabled: z.boolean(),
  code: StatsCardCodeSchema.nullable(),
  updatedAt: z.string().nullable(),
  display: StatsCardDisplaySchema,
});
export type StatsCardState = z.infer<typeof StatsCardStateSchema>;
const headers = c.type<{ authorization: string }>();
const svg = c.otherResponse({
  contentType: "image/svg+xml",
  body: c.type<Blob>(),
});

export const statsCardContract = c.router({
  updateDisplay: {
    method: "PATCH",
    path: "/me/stats-card",
    headers,
    body: StatsCardDisplayPatchSchema,
    responses: { 200: StatsCardStateSchema },
  },
  state: {
    method: "GET",
    path: "/me/stats-card",
    headers,
    responses: { 200: StatsCardStateSchema },
  },
  enable: {
    method: "POST",
    path: "/me/stats-card",
    headers,
    body: StatsCardMutationSchema,
    responses: { 200: StatsCardStateSchema },
  },
  rotate: {
    method: "POST",
    path: "/me/stats-card/rotate",
    headers,
    body: StatsCardMutationSchema,
    responses: { 200: StatsCardStateSchema },
  },
  disable: {
    method: "DELETE",
    path: "/me/stats-card",
    headers,
    body: c.noBody(),
    responses: { 200: StatsCardStateSchema },
  },
  preview: {
    method: "GET",
    path: "/me/stats-card/preview.svg",
    headers,
    query: StatsCardQuerySchema,
    responses: { 200: svg },
  },
  image: {
    method: "GET",
    path: "/stats/:code/card.svg",
    pathParams: z.object({ code: StatsCardCodeSchema }),
    query: StatsCardQuerySchema,
    responses: { 200: svg, 304: c.noBody() },
  },
});
