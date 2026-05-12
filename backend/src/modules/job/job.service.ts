import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';

import { SyncService } from '../sync/sync.service';
import { UsersService } from '../users/users.service';
import { MusicEntity } from '../music/music.schema';
import { JobTempCacheService } from './cache/temp-cache.service';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';
import { BotStatusService } from '../admin/bot-status.service';
import type {
  JobPatchBody,
  JobResponse,
  JobStage,
  JobStatus,
  JobType,
} from './job.types';
import { JobEntity } from './job.schema';

export interface RecentJobStats {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDuration: number | null;
}

const DEAD_JOB_TIMEOUT_MS = Number(
  process.env.DEAD_JOB_TIMEOUT_MS ?? 1 * 30 * 1000,
);

/** Queued jobs older than this are automatically failed (default: 5 min) */
const QUEUED_JOB_TIMEOUT_MS = Number(
  process.env.QUEUED_JOB_TIMEOUT_MS ?? 5 * 60 * 1000,
);

// [TODO] Change this to 1min
// const MIN_CREATE_INTERVAL_MS = Number(
//   process.env.MIN_CREATE_INTERVAL_MS ?? 1000 * 60,
// );

function toJobResponse(job: JobEntity): JobResponse {
  return {
    id: job.id,
    friendCode: job.friendCode,
    jobType: job.jobType ?? 'immediate',
    skipUpdateScore: job.skipUpdateScore,
    fullSync: job.fullSync ?? false,
    botUserFriendCode: job.botUserFriendCode ?? null,
    friendRequestSentAt: job.friendRequestSentAt ?? null,
    status: job.status,
    stage: job.stage,
    // result: job.result,
    profile: job.profile,
    scoreProgress: job.scoreProgress ?? null,
    updateScoreDuration: job.updateScoreDuration ?? null,
    autoExportResult: job.autoExportResult ?? null,
    isAuthenticated: job.isAuthenticated ?? false,
    cabinetScoreMap: job.cabinetScoreMap ?? null,
    diffsToScrape: job.diffsToScrape ?? null,
    error: job.error ?? null,
    executing: job.executing,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const VALID_STATUS: readonly JobStatus[] = [
  'queued',
  'processing',
  'completed',
  'canceled',
  'failed',
] as const;

const VALID_STAGE: readonly JobStage[] = [
  'send_request',
  'wait_acceptance',
  'update_score',
  'fetch_friend_list',
] as const;

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    private readonly syncService: SyncService,
    private readonly tempCacheService: JobTempCacheService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly sdgb: SdgbJobDispatcher,
    @Inject(forwardRef(() => BotStatusService))
    private readonly botStatus: BotStatusService,
  ) {}

  /**
   * Cached set of musicIds we know about (from mongo `musics` collection).
   * Used by the cabinet diff algorithm to ignore "unknown" musicIds —
   * cabinet returns ~86 entries for fc=634142510810999 whose musicId
   * doesn't exist in our music data (probably old/delisted standard
   * charts not in the diving-fish source). Without this filter, those
   * unknown IDs are counted as "new charts" → wrongly inflate
   * diffsToScrape and force the worker to scrape useless friend-VS
   * pages.
   *
   * 5-minute TTL is plenty: musics table only updates from a 6h cron.
   */
  private validMusicIdsCache: { ids: Set<string>; at: number } | null = null;
  private async getValidMusicIds(): Promise<Set<string>> {
    const now = Date.now();
    if (
      this.validMusicIdsCache &&
      now - this.validMusicIdsCache.at < 5 * 60 * 1000
    ) {
      return this.validMusicIdsCache.ids;
    }
    const docs = await this.musicModel
      .find({}, { id: 1, _id: 0 })
      .lean()
      .exec();
    const ids = new Set<string>(
      docs.map((d) => String((d as { id: string }).id)),
    );
    this.validMusicIdsCache = { ids, at: now };
    return ids;
  }

  async create(input: {
    friendCode: string;
    skipUpdateScore: boolean;
    fullSync?: boolean;
    jobType?: JobType;
    botUserFriendCode?: string | null;
    isAuthenticated?: boolean;
    /**
     * Only meaningful when jobType=`idle_update_score`. Set by
     * AutoUpdateScheduler to the score hash it observed; propagates to
     * `user.lastScoreHash` only after this job completes successfully.
     */
    sourceScoreHash?: string | null;
    /**
     * Optional cabinet-derived score data (set by AutoUpdateScheduler when
     * sdgb getRivalHash returned music in addition to hash). Worker uses
     * this to skip half the friend-VS requests (achievement + dxScore are
     * authoritative from cabinet; only fc/fs still need scraping).
     * Shape: { "<musicId>_<chartIndex>": { achievement, dxScore } }.
     */
    cabinetScoreMap?: Record<string, { achievement: number; dxScore: number }> | null;
    /**
     * Optional list of difficulties the worker should scrape. When set,
     * worker only fetches friend-VS for these diffs (typical: only the
     * diffs whose cabinet scores actually changed since last sync). When
     * absent, worker uses its default diff list.
     */
    diffsToScrape?: number[] | null;
    /**
     * Pre-fetched cabinet music from a recent sdgb getRivalHash. When
     * the caller (e.g. AutoUpdateScheduler.runSweep) just made the
     * call, it can hand the result here so JobService doesn't make a
     * redundant sdgb call. Used to derive cabinetScoreMap +
     * diffsToScrape in one place instead of duplicating logic at every
     * job-create caller.
     */
    cabinetMusic?: SdgbWorkerMusicEntry[] | null;
  }) {
    const id = randomUUID();
    const now = new Date();
    const resolvedJobType: JobType = input.jobType ?? 'immediate';

    // [TODO] 将这个限流改为 ip 黑名单机制，同一时间对于一个 friend code 的请求如果过于频繁就拒绝
    // const recent = await this.jobModel
    //   .findOne({ friendCode: input.friendCode })
    //   .sort({ createdAt: -1 });
    // if (recent) {
    //   const diff = now.getTime() - recent.createdAt.getTime();
    //   if (diff < MIN_CREATE_INTERVAL_MS) {
    //     throw new BadRequestException('请求过于频繁，请等待一分钟过后重试！');
    //   }
    // }

    await this.jobModel.updateMany(
      {
        friendCode: input.friendCode,
        status: { $nin: ['completed', 'failed', 'canceled'] },
      },
      {
        $set: {
          status: 'canceled',
          executing: false,
          updatedAt: now,
        },
      },
    );

    let resolvedStage: JobStage;
    if (resolvedJobType === 'idle_update_score') {
      resolvedStage = 'update_score';
    } else if (resolvedJobType === 'fetch_friend_list') {
      resolvedStage = 'fetch_friend_list';
    } else {
      resolvedStage = 'send_request';
    }

    // Cabinet-bound user fast-path: if the user has cabinetUserId, ask
    // sdgb to addRival on their behalf and skip the dxnet
    // send_request → wait_acceptance dance entirely. Applies to any
    // jobType that ends up scraping scores; explicit non-update jobs
    // (idle_add_friend / fetch_friend_list / skipUpdateScore) keep the
    // original flow.
    //
    // 调用方（FE / scheduler）传 botUserFriendCode 是可选的：
    //   - AutoUpdateScheduler / IdleUpdateScheduler 会预先 pickAvailableCabinetBot
    //     再 enqueue，所以总有 bot
    //   - JobController.create（用户点"更新数据"）不传 bot，这里需要自己挑一个
    //     cabinet-bound 的，否则 fast-path 永远进不去，用户还得手动接好友
    //
    // sdgb 失败处理（用户区分）：
    //   - immediate（用户从前端点"更新数据"）：await addRival；如果 sdgb
    //     挂了，**fallback 走原 send_request 流程让用户手动接好友**，
    //     不能让 sdgb 一挂用户就完全不能更新
    //   - idle_update_score（自动更新）：scheduler 在 enqueue 前已经做过
    //     一次 addRival 了（auto-update-scheduler.ts），那里的 addRival
    //     是 required 的；这里再做一次只是冗余的 best-effort，保留
    //     fire-and-forget 即可
    const isScoreUpdateJob =
      (resolvedJobType === 'immediate' ||
        resolvedJobType === 'idle_update_score') &&
      !input.skipUpdateScore;
    if (isScoreUpdateJob) {
      try {
        const user = await this.usersService.findByFriendCode(input.friendCode);
        const userCabinetUid = (user as { cabinetUserId?: number | null } | null)
          ?.cabinetUserId;
        if (userCabinetUid != null) {
          // Pick the bot — caller-specified or auto-pick.
          let botCabinetUid: number | null = null;
          let botFc: string | null = input.botUserFriendCode ?? null;
          if (botFc) {
            const allBots = await this.botStatus.getAll();
            const bot = allBots.find((b) => b.friendCode === botFc);
            botCabinetUid = bot?.cabinetUserId ?? null;
          } else {
            const picked = await this.botStatus.pickAvailableCabinetBot();
            if (picked) {
              botFc = picked.friendCode;
              botCabinetUid = picked.cabinetUserId ?? null;
              input.botUserFriendCode = botFc;
            }
          }

          if (botCabinetUid != null && botFc) {
            // ── addRival ────────────────────────────────────────
            // immediate: synchronous, fall back to send_request on
            // failure so the user can complete via the friend-request
            // flow instead of staring at a stuck stage=update_score.
            // idle_update_score: scheduler already addRival'd before
            // enqueue, this is best-effort backup.
            let addRivalOk = true;
            if (resolvedJobType === 'immediate') {
              try {
                const r = await this.sdgb.addRival(
                  {
                    botCabinetUserId: botCabinetUid,
                    targetCabinetUserId: userCabinetUid,
                  },
                  { tag: `score-update-add:${input.friendCode}`, timeoutMs: 60_000 },
                );
                resolvedStage = 'update_score';
                this.logger.log(
                  `Cabinet fast-path fc=${input.friendCode} bot=${botFc} addRival rc=${r.returnCode1}/${r.returnCode2}`,
                );
              } catch (err) {
                addRivalOk = false;
                this.logger.warn(
                  `Cabinet fast-path addRival failed for fc=${input.friendCode}; falling back to send_request: ${err instanceof Error ? err.message : err}`,
                );
              }
            } else {
              // idle: stage already update_score from scheduler intent.
              resolvedStage = 'update_score';
              this.sdgb
                .addRival(
                  {
                    botCabinetUserId: botCabinetUid,
                    targetCabinetUserId: userCabinetUid,
                  },
                  { tag: `score-update-add:${input.friendCode}`, timeoutMs: 60_000 },
                )
                .then((r) =>
                  this.logger.log(
                    `Cabinet score-update (idle, redundant) fc=${input.friendCode} bot=${botFc} addRival rc=${r.returnCode1}/${r.returnCode2}`,
                  ),
                )
                .catch((err) =>
                  this.logger.warn(
                    `addRival (idle redundant) failed: ${err instanceof Error ? err.message : err}`,
                  ),
                );
            }

            // ── cabinet music + diff calc (all score-update jobs) ──
            // Capture cabinet's per-chart achievement/dxScore + diff
            // against last sync to derive cabinetScoreMap +
            // diffsToScrape. These let the worker skip half the
            // friend-VS requests and skip unchanged diffs entirely.
            //
            // Only attempt if addRival worked (immediate path) — if
            // sdgb is broken there's no point trying again.
            if (addRivalOk && input.cabinetScoreMap == null) {
              try {
                let music = input.cabinetMusic ?? null;
                if (!music) {
                  // Caller didn't pre-fetch (e.g. immediate path,
                  // admin trigger, idle scheduler that didn't pass
                  // music) — make our own sdgb call.
                  const r = await this.sdgb.getRivalHash(
                    { cabinetUserId: userCabinetUid },
                    {
                      tag: `score-update-music:${input.friendCode}`,
                      timeoutMs: 60_000,
                    },
                  );
                  music = r.music;
                }
                const cabinetScoreMap: Record<
                  string,
                  { achievement: number; dxScore: number }
                > = {};
                for (const m of music ?? []) {
                  for (const d of m.userRivalMusicDetailList ?? []) {
                    cabinetScoreMap[`${m.musicId}_${d.level}`] = {
                      achievement: d.achievement,
                      dxScore: d.deluxscoreMax,
                    };
                  }
                }
                if (Object.keys(cabinetScoreMap).length > 0) {
                  input.cabinetScoreMap = cabinetScoreMap;

                  // Compute diffsToScrape if caller didn't already.
                  if (input.diffsToScrape == null) {
                    try {
                      // Filter out cabinet entries whose musicId we
                      // don't have in our music data (e.g. delisted
                      // standard charts cabinet still returns). Without
                      // this, every such entry counts as a "new chart"
                      // and inflates diffsToScrape to cover all diffs,
                      // which makes the worker scrape useless friend-VS
                      // pages — exactly the symptom we saw on
                      // fc=634142510810999 (86 unknown ids → diffs=[0,1,2,3,4]).
                      const validIds = await this.getValidMusicIds();
                      const prev = await this.syncService
                        .getLatestWithScores(input.friendCode)
                        .catch(() => null);
                      if (prev && Array.isArray(prev.scores)) {
                        const prevMap = new Map<
                          string,
                          { achievement: number; dxScore: number }
                        >();
                        for (const s of prev.scores) {
                          const ach = s.score
                            ? Math.round(parseFloat(String(s.score)) * 10000)
                            : 0;
                          const dx = s.dxScore
                            ? parseInt(String(s.dxScore), 10) || 0
                            : 0;
                          prevMap.set(`${s.musicId}_${s.chartIndex}`, {
                            achievement: ach,
                            dxScore: dx,
                          });
                        }
                        const changedDiffs = new Set<number>();
                        let skippedUnknown = 0;
                        for (const [key, cur] of Object.entries(
                          cabinetScoreMap,
                        )) {
                          const lastUnderscore = key.lastIndexOf('_');
                          const musicId = key.slice(0, lastUnderscore);
                          if (!validIds.has(musicId)) {
                            skippedUnknown++;
                            continue;
                          }
                          const before = prevMap.get(key);
                          if (
                            !before ||
                            before.achievement !== cur.achievement ||
                            before.dxScore !== cur.dxScore
                          ) {
                            const lvl = parseInt(
                              key.slice(lastUnderscore + 1),
                              10,
                            );
                            if (Number.isFinite(lvl)) changedDiffs.add(lvl);
                          }
                        }
                        if (skippedUnknown > 0) {
                          this.logger.log(
                            `Cabinet diff fc=${input.friendCode}: skipped ${skippedUnknown} unknown musicIds (not in db)`,
                          );
                        }
                        if (changedDiffs.size > 0) {
                          input.diffsToScrape = [...changedDiffs].sort(
                            (a, b) => a - b,
                          );
                          this.logger.log(
                            `Cabinet diff fc=${input.friendCode}: scraping diffs [${input.diffsToScrape.join(',')}] only (cabinet=${Object.keys(cabinetScoreMap).length} entries)`,
                          );
                        }
                      }
                    } catch (err) {
                      this.logger.warn(
                        `diff calc failed for fc=${input.friendCode}, worker will scrape default diffs: ${err instanceof Error ? err.message : err}`,
                      );
                    }
                  }

                  this.logger.log(
                    `Cabinet music captured for fc=${input.friendCode}: ${Object.keys(cabinetScoreMap).length} entries${
                      input.diffsToScrape
                        ? `, diffs=[${input.diffsToScrape.join(',')}]`
                        : ''
                    }`,
                  );
                }
              } catch (err) {
                this.logger.warn(
                  `cabinet music fetch failed for fc=${input.friendCode}, worker will scrape both VS passes: ${err instanceof Error ? err.message : err}`,
                );
              }
            }
          }
        }
      } catch (err) {
        // Lookup failure is non-fatal — fall back to original send_request flow.
        this.logger.warn(
          `cabinet-bound fast-path lookup failed for ${input.friendCode}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const created = await this.jobModel.create({
      id,
      friendCode: input.friendCode,
      jobType: resolvedJobType,
      skipUpdateScore: input.skipUpdateScore,
      fullSync: input.fullSync ?? false,
      botUserFriendCode: input.botUserFriendCode ?? null,
      friendRequestSentAt: null,
      status: 'queued',
      stage: resolvedStage,
      executing: false,
      error: null,
      result: undefined,
      isAuthenticated: input.isAuthenticated ?? false,
      sourceScoreHash: input.sourceScoreHash ?? null,
      cabinetScoreMap: input.cabinetScoreMap ?? null,
      diffsToScrape: input.diffsToScrape ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return { jobId: id, job: toJobResponse(created.toObject() as JobEntity) };
  }

  /**
   * Out-of-band helper for QR-login: enqueue a fetch_friend_list job
   * pre-assigned to a specific bot, then await its completion. We
   * bypass the regular create() because:
   *  - the friendCode column is the BOT's own friendCode (not a user's),
   *    so the "cancel sibling jobs for same friendCode" rule there
   *    would clobber unrelated immediate / idle jobs for that bot.
   *  - we want to await the result inline.
   *
   * Throws if the job ends up in failed/canceled or if `timeoutMs` elapses.
   */
  async fetchFriendList(
    botUserFriendCode: string,
    timeoutMs = 60_000,
  ): Promise<{
    jobId: string;
    friends: Array<{
      friendCode: string;
      userName: string | null;
      rating: number | null;
    }>;
  }> {
    const id = randomUUID();
    const now = new Date();
    await this.jobModel.create({
      id,
      // friendCode here identifies the bot (not a user) — informational only
      // for fetch_friend_list jobs.
      friendCode: botUserFriendCode,
      jobType: 'fetch_friend_list',
      skipUpdateScore: true,
      botUserFriendCode,
      friendRequestSentAt: null,
      status: 'queued',
      stage: 'fetch_friend_list',
      executing: false,
      error: null,
      result: undefined,
      isAuthenticated: true,
      sourceScoreHash: null,
      createdAt: now,
      updatedAt: now,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const doc = await this.jobModel.findOne({ id }).lean();
      if (!doc) throw new Error(`fetch_friend_list job ${id} disappeared`);
      if (doc.status === 'completed') {
        const friends =
          (doc.result as { friends?: unknown } | undefined)?.friends;
        if (!Array.isArray(friends)) {
          throw new Error(`fetch_friend_list job ${id} result missing friends`);
        }
        return {
          jobId: id,
          friends: friends as Array<{
            friendCode: string;
            userName: string | null;
            rating: number | null;
          }>,
        };
      }
      if (doc.status === 'failed' || doc.status === 'canceled') {
        throw new Error(
          `fetch_friend_list job ${id} ended ${doc.status}: ${doc.error ?? '(no detail)'}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    throw new Error(`fetch_friend_list job ${id} timed out after ${timeoutMs}ms`);
  }

  async get(jobId: string): Promise<JobResponse> {
    const job = await this.jobModel.findOne({ id: jobId });
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return toJobResponse(job.toObject() as JobEntity);
  }

  async claimNext(botUserFriendCode: string): Promise<JobResponse | null> {
    const now = new Date();

    // Release stale executing jobs before claiming.
    const staleThreshold = new Date(now.getTime() - DEAD_JOB_TIMEOUT_MS);
    await this.jobModel.updateMany(
      { executing: true, updatedAt: { $lte: staleThreshold } },
      { $set: { executing: false } },
    );

    // Fail queued jobs that have been waiting too long (unassigned only).
    const queuedDeadline = new Date(now.getTime() - QUEUED_JOB_TIMEOUT_MS);
    await this.jobModel.updateMany(
      {
        status: 'queued',
        botUserFriendCode: null,
        createdAt: { $lte: queuedDeadline },
      },
      {
        $set: {
          status: 'failed',
          error: '排队超时，可能是 Bot 繁忙或异常，请稍后再试',
          updatedAt: now,
        },
      },
    );

    // 0) Top priority: fetch_friend_list jobs pre-assigned to this bot.
    //    These back blocking QR-login requests, so they jump ahead of
    //    everything — even resume-in-progress and the unassigned queue.
    {
      const fetchFL = await this.jobModel.findOneAndUpdate(
        {
          status: 'queued',
          executing: false,
          botUserFriendCode,
          jobType: 'fetch_friend_list',
        },
        {
          $set: {
            status: 'processing',
            executing: true,
            updatedAt: now,
          },
        },
        { new: true, sort: { createdAt: 1 } },
      );
      if (fetchFL) {
        return toJobResponse(fetchFL.toObject() as JobEntity);
      }
    }

    // 1a) Queued first: claim the oldest unassigned queued job.
    //     To balance load across bots, only allow this bot to claim a new queued
    //     job if it doesn't already have more active jobs than any other bot.
    const activeCountForThisBot = await this.jobModel.countDocuments({
      botUserFriendCode,
      status: 'processing',
    });

    // Find the minimum active job count among all OTHER bots that have processing jobs.
    // If no other bots have any jobs, minOtherCount stays at Infinity and this bot can claim.
    const otherBotCounts = await this.jobModel.aggregate<{
      _id: string;
      count: number;
    }>([
      {
        $match: {
          status: 'processing',
          botUserFriendCode: { $ne: null, $nin: [botUserFriendCode] },
        },
      },
      { $group: { _id: '$botUserFriendCode', count: { $sum: 1 } } },
    ]);

    // When no other bots have processing jobs, skip the balance check entirely
    // so the only active bot is not artificially capped at 2.
    const shouldBalanceCheck = otherBotCounts.length > 0;
    const minOtherCount = shouldBalanceCheck
      ? Math.min(...otherBotCounts.map((b) => b.count))
      : 0;

    // Only claim new queued job if this bot's active count is not too far ahead of others.
    // Allow up to 1 more than the minimum, so a single bot going offline won't block others.
    // When this is the only active bot, skip the check entirely.
    if (!shouldBalanceCheck || activeCountForThisBot <= minOtherCount + 1) {
      // Find the oldest unassigned queued job
      const candidates = await this.jobModel
        .find({ status: 'queued', executing: false, botUserFriendCode: null })
        .sort({ updatedAt: 1 })
        .limit(10)
        .lean();

      for (const candidate of candidates) {
        // Check preferred bot: if job is queued < 30s and user prefers a different bot, skip
        const queuedDuration = now.getTime() - candidate.createdAt.getTime();
        if (queuedDuration < 30_000) {
          const preferredBot = await this.usersService.getPreferredBot(
            candidate.friendCode,
          );
          if (preferredBot && preferredBot !== botUserFriendCode) {
            continue; // Let the preferred bot pick this job
          }
        }

        // Try to atomically claim this job
        const claimed = await this.jobModel.findOneAndUpdate(
          {
            id: candidate.id,
            status: 'queued',
            executing: false,
            botUserFriendCode: null,
          },
          {
            $set: {
              status: 'processing',
              executing: true,
              botUserFriendCode,
              updatedAt: now,
            },
          },
          { new: true },
        );
        if (claimed) {
          return toJobResponse(claimed.toObject() as JobEntity);
        }
      }
    }

    // 1b) Resume: pick the oldest processing job for this bot.
    //     Only pick jobs whose updatedAt <= now (future updatedAt = intentional cooldown
    //     from wait_acceptance stage).
    const processing = await this.jobModel.findOneAndUpdate(
      {
        status: 'processing',
        botUserFriendCode,
        executing: false,
        updatedAt: { $lte: now },
      },
      {
        $set: {
          executing: true,
          updatedAt: now,
        },
      },
      { new: true, sort: { updatedAt: 1 } },
    );
    if (processing) {
      return toJobResponse(processing.toObject() as JobEntity);
    }

    // 2) Idle pool: claim pre-assigned queued jobs (e.g. idle_update_score)
    //    Lowest priority — only picked when no main pool jobs are available.
    const idle = await this.jobModel.findOneAndUpdate(
      { status: 'queued', executing: false, botUserFriendCode },
      {
        $set: {
          status: 'processing',
          executing: true,
          updatedAt: now,
        },
      },
      { new: true, sort: { createdAt: 1 } },
    );

    if (!idle) return null;
    return toJobResponse(idle.toObject() as JobEntity);
  }

  async patch(jobId: string, body: JobPatchBody): Promise<JobResponse> {
    const update: Partial<JobEntity> = {};
    const additionalOps: Record<string, unknown> = {};

    if (body.botUserFriendCode !== undefined) {
      if (
        body.botUserFriendCode !== null &&
        typeof body.botUserFriendCode !== 'string'
      ) {
        throw new BadRequestException(
          'botUserFriendCode must be a string or null',
        );
      }
      update.botUserFriendCode = body.botUserFriendCode;
    }

    if (body.status !== undefined) {
      if (!VALID_STATUS.includes(body.status)) {
        throw new BadRequestException('Invalid status value');
      }
      update.status = body.status;
    }

    if (body.stage !== undefined) {
      if (!VALID_STAGE.includes(body.stage)) {
        throw new BadRequestException('Invalid stage value');
      }
      update.stage = body.stage;
    }

    if (body.result !== undefined) {
      update.result = body.result;
    }

    if (body.profile !== undefined) {
      update.profile = body.profile;
    }

    if (body.error !== undefined) {
      if (body.error !== null && typeof body.error !== 'string') {
        throw new BadRequestException('error must be a string or null');
      }
      update.error = body.error;
    }

    if (body.friendRequestSentAt !== undefined) {
      if (
        body.friendRequestSentAt !== null &&
        typeof body.friendRequestSentAt !== 'string'
      ) {
        throw new BadRequestException(
          'friendRequestSentAt must be a string or null',
        );
      }
      update.friendRequestSentAt = body.friendRequestSentAt;
    }

    if (body.executing !== undefined) {
      if (typeof body.executing !== 'boolean') {
        throw new BadRequestException('executing must be a boolean');
      }
      update.executing = body.executing;
    }

    if (body.updatedAt !== undefined) {
      if (typeof body.updatedAt !== 'string') {
        throw new BadRequestException('updatedAt must be an ISO string');
      }
      const parsed = new Date(body.updatedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('updatedAt must be a valid ISO date');
      }
      update.updatedAt = parsed;
    } else {
      update.updatedAt = new Date();
    }

    // 处理 updateScoreDuration
    if (body.updateScoreDuration !== undefined) {
      if (
        body.updateScoreDuration !== null &&
        typeof body.updateScoreDuration !== 'number'
      ) {
        throw new BadRequestException(
          'updateScoreDuration must be a number or null',
        );
      }
      update.updateScoreDuration = body.updateScoreDuration;
    }

    // 处理 scoreProgress：完整替换模式
    if (body.scoreProgress !== undefined) {
      update.scoreProgress = body.scoreProgress;
    }

    // 处理 addCompletedDiff：原子追加模式（使用 $addToSet 避免并发冲突）
    if (body.addCompletedDiff !== undefined) {
      if (typeof body.addCompletedDiff !== 'number') {
        throw new BadRequestException('addCompletedDiff must be a number');
      }
      additionalOps.$addToSet = {
        'scoreProgress.completedDiffs': body.addCompletedDiff,
      };
    }

    // 构建更新操作
    const updateOps: Record<string, unknown> = {
      $set: update,
      ...additionalOps,
    };

    const updated = await this.jobModel.findOneAndUpdate(
      { id: jobId },
      updateOps,
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('Job not found');
    }

    // 当 job 进入 wait_acceptance 或完成时，更新用户的偏好 bot
    if (
      updated.botUserFriendCode &&
      (body.stage === 'update_score' || body.status === 'completed')
    ) {
      this.usersService
        .updatePreferredBot(updated.friendCode, updated.botUserFriendCode)
        .catch((err) => {
          this.logger.error(
            `Failed to update preferred bot for ${updated.friendCode}: ${err?.message}`,
          );
        });
    }

    // 当 job 完成、失败或取消时，清理临时缓存
    const finalStatuses: JobStatus[] = ['completed', 'failed', 'canceled'];
    if (finalStatuses.includes(updated.status)) {
      // 异步清理缓存，不阻塞响应
      this.tempCacheService.deleteByJobId(jobId).catch((err) => {
        console.error(`Failed to delete temp cache for job ${jobId}:`, err);
      });
    }

    if (
      updated.status === 'completed' &&
      !updated.skipUpdateScore &&
      updated.result
    ) {
      await this.syncService.createFromJob(updated.toObject() as JobEntity);

      // Fire-and-forget auto-export
      this.runAutoExport(jobId, updated.friendCode).catch((err: Error) => {
        this.logger.error(
          `Auto-export failed for job ${jobId}: ${err?.message}`,
        );
      });
    }

    // Auto-update bookkeeping: when an idle_update_score job that was
    // launched by AutoUpdateScheduler completes successfully, promote
    // its sourceScoreHash onto the user's lastScoreHash. We deliberately
    // wait for completion so a failed/canceled job does not "burn" the
    // hash transition — the next sweep should see the same diff and try
    // again.
    if (
      updated.status === 'completed' &&
      updated.jobType === 'idle_update_score' &&
      updated.sourceScoreHash
    ) {
      this.usersService
        .findByFriendCode(updated.friendCode)
        .then((user) => {
          if (!user) return;
          return this.usersService.update(String(user._id), {
            lastScoreHash: updated.sourceScoreHash,
          });
        })
        .catch((err: Error) => {
          this.logger.warn(
            `Failed to promote sourceScoreHash for job ${jobId}: ${err?.message}`,
          );
        });
    }

    return toJobResponse(updated.toObject() as JobEntity);
  }

  async getActiveFriendCodesByBot(
    botUserFriendCode: string,
  ): Promise<string[]> {
    const jobs = await this.jobModel
      .find({
        botUserFriendCode,
        status: { $nin: ['completed', 'failed', 'canceled'] },
      })
      .select('friendCode')
      .lean();

    return jobs.map((job) => job.friendCode);
  }

  /**
   * 根据 friendCode 获取当前正在执行的任务（queued 或 processing 状态，且 skipUpdateScore 为 false）
   */
  async getActiveByFriendCode(friendCode: string): Promise<JobResponse | null> {
    const job = await this.jobModel
      .findOne({
        friendCode,
        skipUpdateScore: false,
        status: { $in: ['queued', 'processing'] },
      })
      .sort({ createdAt: -1 });

    if (!job) {
      return null;
    }

    return toJobResponse(job.toObject() as JobEntity);
  }

  async getRecentStats(): Promise<RecentJobStats> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const filter = {
      skipUpdateScore: false,
      createdAt: { $gte: oneHourAgo },
    };

    const [totalCount, completedCount, failedCount] = await Promise.all([
      this.jobModel.countDocuments(filter),
      this.jobModel.countDocuments({ ...filter, status: 'completed' }),
      this.jobModel.countDocuments({ ...filter, status: 'failed' }),
    ]);

    // 获取有 updateScoreDuration 的已完成任务的平均时长
    const durationStats = await this.jobModel.aggregate<{
      avgDuration: number;
    }>([
      {
        $match: {
          ...filter,
          status: 'completed',
          updateScoreDuration: { $ne: null, $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          avgDuration: { $avg: '$updateScoreDuration' },
        },
      },
    ]);

    const avgDuration = durationStats[0]
      ? Math.round(durationStats[0].avgDuration)
      : null;

    return {
      totalCount,
      completedCount,
      failedCount,
      successRate:
        totalCount > 0
          ? Math.round((completedCount / totalCount) * 10000) / 100
          : 0,
      avgDuration,
    };
  }

  /**
   * 检查指定 friendCode 是否已有活跃的闲时更新任务
   */
  async hasActiveIdleJob(friendCode: string): Promise<boolean> {
    const count = await this.jobModel.countDocuments({
      friendCode,
      jobType: { $in: ['idle_add_friend', 'idle_update_score'] },
      status: { $in: ['queued', 'processing'] },
    });
    return count > 0;
  }

  async getActiveIdleJob(friendCode: string) {
    const job = await this.jobModel
      .findOne({
        friendCode,
        jobType: { $in: ['idle_add_friend', 'idle_update_score'] },
        status: { $in: ['queued', 'processing'] },
      })
      .sort({ createdAt: -1 });
    if (!job) return null;
    return {
      id: job.id,
      jobType: job.jobType,
      status: job.status,
      stage: job.stage,
      scoreProgress: job.scoreProgress,
      friendRequestSentAt: job.friendRequestSentAt,
    };
  }

  /**
   * 清理创建时间在七天之前的所有 job
   */
  async cleanupOldJobs(): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.jobModel.deleteMany({
      createdAt: { $lt: sevenDaysAgo },
    });
    return result.deletedCount;
  }

  /**
   * 自动导出：检查用户设置，异步导出到 diving-fish / lxns，
   * 完成后将结果写回 job.autoExportResult
   */
  private async runAutoExport(
    jobId: string,
    friendCode: string,
  ): Promise<void> {
    const user = await this.usersService.findByFriendCode(friendCode);
    if (!user) return;

    const userDoc = user as unknown as Record<string, unknown>;
    const shouldExportDf =
      !!userDoc.autoExportDivingFish && !!user.divingFishImportToken;
    const shouldExportLxns = !!userDoc.autoExportLxns && !!user.lxnsImportToken;

    if (!shouldExportDf && !shouldExportLxns) return;

    const exportResult: {
      divingFish?: { status: string; message?: string } | null;
      lxns?: { status: string; message?: string } | null;
    } = {};

    if (shouldExportDf) {
      try {
        const res = await this.syncService.exportToDivingFish(
          friendCode,
          user.divingFishImportToken!,
        );
        exportResult.divingFish = {
          status: 'success',
          message: `导出 ${res.exported ?? 0} 条成绩`,
        };
        this.logger.log(`Auto-export to DivingFish succeeded for job ${jobId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        exportResult.divingFish = { status: 'failed', message: msg };
        this.logger.warn(
          `Auto-export to DivingFish failed for job ${jobId}: ${msg}`,
        );
      }
    }

    if (shouldExportLxns) {
      try {
        const res = await this.syncService.exportToLxns(
          friendCode,
          user.lxnsImportToken!,
        );
        exportResult.lxns = {
          status: 'success',
          message: `导出 ${res.exported ?? 0} 条成绩`,
        };
        this.logger.log(`Auto-export to LXNS succeeded for job ${jobId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        exportResult.lxns = { status: 'failed', message: msg };
        this.logger.warn(`Auto-export to LXNS failed for job ${jobId}: ${msg}`);
      }
    }

    // Write results back to the job document and the sync record
    await Promise.all([
      this.jobModel.updateOne(
        { id: jobId },
        { $set: { autoExportResult: exportResult } },
      ),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      this.syncService.updateAutoExportResult(jobId, exportResult),
    ]);
  }
}
