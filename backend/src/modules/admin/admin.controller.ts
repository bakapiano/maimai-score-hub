import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ReportBotStatusBodySchema,
  SearchJobsQuerySchema,
  UpdateBotCabinetUserIdBodySchema,
  UpdateBotRemarkBodySchema,
  UpdateSystemSettingsBodySchema,
  type ReportBotStatusBody,
  type SearchJobsQuery,
  type UpdateBotCabinetUserIdBody,
  type UpdateBotRemarkBody,
  type UpdateSystemSettingsBody,
} from '@maimai-score-hub/shared';

import { AdminGuard } from './admin.guard';
import { WorkerAuthGuard } from '../../common/guards/worker-auth.guard';
import { AdminService } from './admin.service';
import { BotFriendSnapshotService } from './bot-friend-snapshot.service';
import { BotStatusService } from './bot-status.service';
import { JobApiLogService } from '../job/api-log/api-log.service';
import { JobService } from '../job/job.service';
import { IdleUpdateSchedulerService } from '../job/idle-update/idle-update-scheduler.service';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';
import { SdgbJobService } from '../sdgb-worker/sdgb-job.service';
import { SystemSettingsService } from './system-settings.service';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly botStatusService: BotStatusService,
    private readonly botFriendSnapshotService: BotFriendSnapshotService,
    private readonly apiLogService: JobApiLogService,
    private readonly idleUpdateScheduler: IdleUpdateSchedulerService,
    private readonly jobService: JobService,
    private readonly sdgbJobService: SdgbJobService,
    private readonly sdgbDispatcher: SdgbJobDispatcher,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Worker 上报 Bot 状态（X-Admin-Password 校验，
   * 与 admin guard 共享同一个 ADMIN_PASSWORD 但接受 worker 心跳）
   */
  @Post('bot-status')
  @UseGuards(WorkerAuthGuard)
  async reportBotStatus(
    @Body(new ZodValidationPipe(ReportBotStatusBodySchema))
    body: ReportBotStatusBody,
  ) {
    await this.botStatusService.report(body.bots);
    // Side-channel: any bot row that included a `friends` array also
    // gets full-overwritten into bot_friend_snapshots for the QR-login
    // reverse-map flow. Workers send this opportunistically on every tick.
    // Same friends array also drives user.profile auto-population so QR-
    // login users get an avatar/title/etc without an extra RPC.
    const allFriends: NonNullable<(typeof body.bots)[0]['friends']> = [];
    for (const b of body.bots) {
      if (Array.isArray(b.friends)) {
        await this.botFriendSnapshotService.report(
          b.friendCode,
          b.friends.map((f) => ({
            friendCode: f.friendCode,
            userName: f.userName ?? null,
            rating: f.rating ?? null,
          })),
        );
        allFriends.push(...b.friends);
      }
    }
    if (allFriends.length > 0) {
      // Best-effort: profile patching shouldn't fail the heartbeat.
      void this.usersService
        .patchProfilesFromFriendList(allFriends)
        .catch(() => {});
    }
    return { ok: true };
  }

  /**
   * Admin 查询某个 bot 的好友 snapshot（debug 用）。
   */
  @Get('bot-friend-snapshots/:botFriendCode')
  @UseGuards(AdminGuard)
  async getBotFriendSnapshot(
    @Param('botFriendCode') botFriendCode: string,
  ) {
    const snap = await this.botFriendSnapshotService.get(botFriendCode);
    if (!snap) return { botFriendCode, friends: [], updatedAt: null };
    return snap;
  }

  /**
   * 查询 Bot 状态（需要 admin 密码）
   */
  @Get('bot-status')
  @UseGuards(AdminGuard)
  async getBotStatus() {
    return this.botStatusService.getAll();
  }

  @Patch('bot-status/:friendCode/remark')
  @UseGuards(AdminGuard)
  async updateBotRemark(
    @Param('friendCode') friendCode: string,
    @Body(new ZodValidationPipe(UpdateBotRemarkBodySchema))
    body: UpdateBotRemarkBody,
  ) {
    await this.botStatusService.updateRemark(friendCode, body.remark);
    return { ok: true };
  }

  /**
   * Configure the cabinet (sdgb) userId for a bot. The auto-update flow uses
   * this id as `userId1` of UserFriendRegistApi when adding a user as the
   * bot's rival on the cabinet side.
   */
  @Patch('bot-status/:friendCode/cabinet-user-id')
  @UseGuards(AdminGuard)
  async updateBotCabinetUserId(
    @Param('friendCode') friendCode: string,
    @Body(new ZodValidationPipe(UpdateBotCabinetUserIdBodySchema))
    body: UpdateBotCabinetUserIdBody,
  ) {
    await this.botStatusService.setCabinetUserId(friendCode, body.cabinetUserId);
    return { ok: true };
  }

  /**
   * Remove a bot row from the bot_statuses collection.
   * Use case: bot's worker is permanently dead and the row clutters
   * admin UI. If the worker is actually still alive its next 60s
   * heartbeat will recreate the row, so this is safe — there's no
   * "blacklist" semantic. Also nulls out user.idleUpdateBotFriendCode
   * pointers to avoid dangling references.
   */
  @Delete('bot-status/:friendCode')
  @UseGuards(AdminGuard)
  async removeBot(@Param('friendCode') friendCode: string) {
    if (!friendCode || !/^\d+$/.test(friendCode)) {
      throw new BadRequestException('friendCode must be a numeric string');
    }
    const result = await this.botStatusService.remove(friendCode);
    return { ok: true, ...result };
  }

  @Get('stats')
  @UseGuards(AdminGuard)
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('job-stats')
  @UseGuards(AdminGuard)
  async getJobStats() {
    return await this.adminService.getJobStats();
  }

  /**
   * Aggregated dashboard for /admin/auto-update.
   * window: '24h' (5min buckets) or '7d' (1h buckets).
   */
  @Get('auto-update-metrics')
  @UseGuards(AdminGuard)
  async getAutoUpdateMetrics(@Query('window') window?: string) {
    const w: '24h' | '7d' = window === '7d' ? '7d' : '24h';
    return this.adminService.getAutoUpdateMetrics(w);
  }

  /**
   * Aggregated stats for prober auto-export across ALL job types
   * (not limited to auto-update). Source: jobs.autoExportResult.
   */
  @Get('prober-export-metrics')
  @UseGuards(AdminGuard)
  async getProberExportMetrics(@Query('window') window?: string) {
    const w: '24h' | '7d' = window === '7d' ? '7d' : '24h';
    return this.adminService.getProberExportMetrics(w);
  }

  @Get('job-trend')
  @UseGuards(AdminGuard)
  async getJobTrend(@Query('hours') hoursStr?: string) {
    const hours = hoursStr
      ? Math.min(Math.max(parseInt(hoursStr, 10) || 24, 1), 720)
      : 24;
    return await this.adminService.getJobTrend(hours);
  }

  @Get('job-error-stats')
  @UseGuards(AdminGuard)
  async getJobErrorStats() {
    return await this.adminService.getJobErrorStats();
  }

  @Get('users')
  @UseGuards(AdminGuard)
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }

  @Post('sync-covers')
  @UseGuards(AdminGuard)
  async syncCovers() {
    const result = await this.adminService.syncCovers();
    return { ok: true, ...result };
  }

  @Post('force-sync-covers')
  @UseGuards(AdminGuard)
  async forceSyncCovers() {
    const result = await this.adminService.forceSyncCovers();
    return { ok: true, ...result };
  }

  @Post('sync-music')
  @UseGuards(AdminGuard)
  async syncMusic() {
    const result = await this.adminService.syncMusic();
    return { ok: true, ...result };
  }

  @Get('active-jobs')
  @UseGuards(AdminGuard)
  async getActiveJobs() {
    return await this.adminService.getActiveJobs();
  }

  @Get('jobs')
  @UseGuards(AdminGuard)
  async searchJobs(
    @Query(new ZodValidationPipe(SearchJobsQuerySchema)) query: SearchJobsQuery,
  ) {
    return await this.adminService.searchJobs({
      friendCode: query.friendCode,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('jobs/:jobId/api-logs')
  @UseGuards(AdminGuard)
  async getJobApiLogs(@Param('jobId') jobId: string) {
    return await this.apiLogService.getLogsByJobId(jobId);
  }

  @Post('trigger-idle-update')
  @UseGuards(AdminGuard)
  async triggerIdleUpdate() {
    const result = await this.idleUpdateScheduler.triggerNow();
    return { ok: true, ...result };
  }

  /**
   * 清理创建时间在七天之前的所有 job
   */
  @Post('cleanup-jobs')
  @UseGuards(AdminGuard)
  async cleanupJobs() {
    const deletedCount = await this.jobService.cleanupOldJobs();
    return { ok: true, deletedCount };
  }

  /**
   * sdgb-worker dashboard data: heartbeats, queue depth, recent jobs.
   * Frontend admin portal polls this every few seconds.
   */
  @Get('sdgb-worker/status')
  @UseGuards(AdminGuard)
  async getSdgbWorkerStatus() {
    return this.sdgbJobService.getAdminStatus();
  }

  /**
   * Paginated, filterable sdgb job list. Query params: jobType, status,
   * tag (substring), page, pageSize.
   */
  @Get('sdgb-worker/jobs')
  @UseGuards(AdminGuard)
  async listSdgbJobs(
    @Query('jobType') jobType?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
  ) {
    const allowedTypes = new Set(['scan_qr', 'get_rival_hash', 'add_rival']);
    const allowedStatus = new Set([
      'queued',
      'processing',
      'completed',
      'failed',
    ]);
    const opts: Parameters<SdgbJobService['listJobs']>[0] = {
      tag: tag?.trim() || undefined,
      page: pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1,
      pageSize: pageSizeStr
        ? Math.min(200, Math.max(1, parseInt(pageSizeStr, 10) || 20))
        : 20,
    };
    if (jobType && allowedTypes.has(jobType)) {
      opts.jobType = jobType as 'scan_qr' | 'get_rival_hash' | 'add_rival';
    }
    if (status && allowedStatus.has(status)) {
      opts.status = status as
        | 'queued'
        | 'processing'
        | 'completed'
        | 'failed';
    }
    return this.sdgbJobService.listJobs(opts);
  }

  /**
   * Bind a bot's cabinetUserId by scanning the bot's card QR. Routes
   * through sdgb-worker (scan_qr job) so the cabinet contract / crypto
   * stays in one place. Body: `{ qrCode: string }`.
   *
   * Admin-only: this writes the cabinetUserId of a bot, which the
   * auto-update flow uses as the userId1 of UserFriendRegistApi.
   */
  @Post('bot-status/:friendCode/bind-cabinet-qr')
  @UseGuards(AdminGuard)
  async bindBotCabinetQr(
    @Param('friendCode') friendCode: string,
    @Body() body: { qrCode?: unknown },
  ) {
    const qrCode =
      typeof body?.qrCode === 'string' ? body.qrCode.trim() : '';
    if (!qrCode) {
      throw new BadRequestException('qrCode (string) required');
    }
    try {
      const result = await this.sdgbDispatcher.scanQr(
        { qrCode },
        { tag: `admin-bot-bind:${friendCode}`, timeoutMs: 120_000 },
      );
      await this.botStatusService.setCabinetUserId(
        friendCode,
        result.cabinetUserId,
      );
      return {
        ok: true,
        friendCode,
        cabinetUserId: result.cabinetUserId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`扫码绑定失败: ${message}`);
    }
  }

  @Get('system-settings')
  @UseGuards(AdminGuard)
  async getSystemSettings() {
    return this.systemSettingsService.get();
  }

  @Patch('system-settings')
  @UseGuards(AdminGuard)
  async updateSystemSettings(
    @Body(new ZodValidationPipe(UpdateSystemSettingsBodySchema))
    body: UpdateSystemSettingsBody,
  ) {
    if (typeof body.cabinetOnlyMode === 'boolean') {
      return this.systemSettingsService.setCabinetOnlyMode(body.cabinetOnlyMode);
    }
    return this.systemSettingsService.get();
  }
}
