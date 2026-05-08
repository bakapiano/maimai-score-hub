import { z } from 'zod';

export const AdminHeaderSchema = z.object({
  'x-admin-password': z.string(),
});

export const BotStatusItemSchema = z
  .object({
    friendCode: z.string(),
    available: z.boolean(),
    friendCount: z.number().nullable().optional(),
    lastReportedAt: z.string().optional(),
    remark: z.string().nullable().optional(),
    cabinetUserId: z.number().int().nullable().optional(),
  })
  .passthrough();

export const ReportBotStatusBodySchema = z.object({
  bots: z.array(
    z.object({
      friendCode: z.string(),
      available: z.boolean(),
      friendCount: z.number().optional(),
    }),
  ),
});

export const UpdateBotRemarkBodySchema = z.object({
  remark: z.string().nullable(),
});

export const UpdateBotCabinetUserIdBodySchema = z.object({
  cabinetUserId: z.number().int().positive().nullable(),
});

export const AdminStatsSchema = z
  .object({
    userCount: z.number().optional(),
    musicCount: z.number().optional(),
    syncCount: z.number().optional(),
    coverCount: z.number().optional(),
  })
  .passthrough();

export const JobStatsSchema = z.unknown();
export const JobTrendSchema = z.unknown();
export const JobErrorStatsSchema = z.unknown();
export const AdminUsersSchema = z.array(z.unknown());
export const ActiveJobsSchema = z.unknown();

export const SearchJobsQuerySchema = z.object({
  friendCode: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export const SearchJobsResponseSchema = z.unknown();
export const JobApiLogsSchema = z.array(z.unknown());

export type ReportBotStatusBody = z.infer<typeof ReportBotStatusBodySchema>;
export type UpdateBotRemarkBody = z.infer<typeof UpdateBotRemarkBodySchema>;
export type UpdateBotCabinetUserIdBody = z.infer<
  typeof UpdateBotCabinetUserIdBodySchema
>;
export type SearchJobsQuery = z.infer<typeof SearchJobsQuerySchema>;
