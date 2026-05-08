import {
  BadRequestException,
  Body,
  Controller,
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
  type ReportBotStatusBody,
  type SearchJobsQuery,
  type UpdateBotCabinetUserIdBody,
  type UpdateBotRemarkBody,
} from '@maimai-score-hub/shared';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { BotStatusService } from './bot-status.service';
import { JobApiLogService } from '../job/api-log/api-log.service';
import { JobService } from '../job/job.service';
import { IdleUpdateSchedulerService } from '../job/idle-update/idle-update-scheduler.service';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';
import { SdgbJobService } from '../sdgb-worker/sdgb-job.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly botStatusService: BotStatusService,
    private readonly apiLogService: JobApiLogService,
    private readonly idleUpdateScheduler: IdleUpdateSchedulerService,
    private readonly jobService: JobService,
    private readonly sdgbJobService: SdgbJobService,
    private readonly sdgbDispatcher: SdgbJobDispatcher,
  ) {}

  /**
   * Worker 上报 Bot 状态（无需 admin 密码）
   */
  @Post('bot-status')
  async reportBotStatus(
    @Body(new ZodValidationPipe(ReportBotStatusBodySchema))
    body: ReportBotStatusBody,
  ) {
    await this.botStatusService.report(body.bots);
    return { ok: true };
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
}
