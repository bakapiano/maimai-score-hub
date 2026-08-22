import { z } from "zod";

import { ManualScoreFcSchema, ManualScoreFsSchema } from "../sync/sync.schema";

export const OcrDifficultySchema = z.enum([
  "basic",
  "advanced",
  "expert",
  "master",
  "remaster",
  "utage",
]);

export const OcrCandidateSchema = z.object({
  title: z.string().min(1),
  confidence: z.number().finite().min(0).max(1).nullable().optional(),
  sources: z.array(z.enum(["cover", "title"])),
});

export const OcrRecognitionItemSchema = z.object({
  index: z.number().int().nonnegative(),
  filename: z.string().min(1),
  status: z.enum(["ok", "unrecognized", "error"]),
  candidates: z.array(OcrCandidateSchema).max(3),
  achievement: z.number().finite().min(0).max(101).nullable().optional(),
  dxScore: z.number().int().safe().nonnegative().nullable().optional(),
  difficulty: OcrDifficultySchema.nullable().optional(),
  level: z.string().nullable().optional(),
  isDx: z.boolean().nullable().optional(),
  fc: ManualScoreFcSchema.nullable().optional(),
  fs: ManualScoreFsSchema.nullable().optional(),
  error: z.string().nullable().optional(),
});

export const OcrBatchRecognitionResponseSchema = z.object({
  results: z.array(OcrRecognitionItemSchema).min(1).max(20),
});

export type OcrDifficulty = z.infer<typeof OcrDifficultySchema>;
export type OcrCandidate = z.infer<typeof OcrCandidateSchema>;
export type OcrRecognitionItem = z.infer<typeof OcrRecognitionItemSchema>;
export type OcrBatchRecognitionResponse = z.infer<
  typeof OcrBatchRecognitionResponseSchema
>;
