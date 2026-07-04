import { z } from "zod";

export const AdminHeaderSchema = z.object({
  "x-api-secret": z.string(),
});

export const BotStatusItemSchema = z
  .object({
    friendCode: z.string(),
    available: z.boolean(),
    friendCount: z.number().nullable().optional(),
    friendsUpdatedAt: z.string().nullable().optional(),
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
      friendsUpdatedAt: z.string().optional(),
      /**
       * Optional rich friend list for the QR-login reverse-mapping
       * feature. Workers populate this on every status tick when the bot
       * cookie is healthy; absent → backend leaves the existing snapshot
       * untouched.
       */
      friends: z
        .array(
          z.object({
            friendCode: z.string(),
            userName: z.string().nullable().optional(),
            rating: z.number().int().nullable().optional(),
            // Profile fields scraped from the friend list block. Backend
            // uses these to populate user.profile for users who joined
            // via QR login and never went through getUserProfile RPC.
            avatarUrl: z.string().nullable().optional(),
            title: z.string().nullable().optional(),
            titleColor: z.string().nullable().optional(),
            ratingBgUrl: z.string().nullable().optional(),
            courseRankUrl: z.string().nullable().optional(),
            classRankUrl: z.string().nullable().optional(),
            awakeningCount: z.number().int().nullable().optional(),
          }),
        )
        .optional(),
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
export const ObservabilityStatusSchema = z.unknown();
export const RealtimeOverviewSchema = z.unknown();
export const RealtimeWorkerGroupsSchema = z.unknown();
export const HistoryRowsSchema = z.array(z.unknown());
export const HistoryLogWorkersSchema = z.array(
  z.object({
    workerId: z.string(),
    workerKind: z.string(),
    lastSeenAt: z.string(),
  }),
);
export const JobDebugSchema = z.unknown();

export type ReportBotStatusBody = z.infer<typeof ReportBotStatusBodySchema>;
export type UpdateBotRemarkBody = z.infer<typeof UpdateBotRemarkBodySchema>;
export type UpdateBotCabinetUserIdBody = z.infer<
  typeof UpdateBotCabinetUserIdBodySchema
>;
export type SearchJobsQuery = z.infer<typeof SearchJobsQuerySchema>;
