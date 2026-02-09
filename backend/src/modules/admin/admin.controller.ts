import { Body, Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { BotStatusService } from './bot-status.service';
import { JobApiLogService } from '../job/job-api-log.service';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly botStatusService: BotStatusService,
    private readonly apiLogService: JobApiLogService,
  ) {}

  /**
   * Worker 上报 Bot 状态（无需 admin 密码）
   */
  @Post('bot-status')
  async reportBotStatus(
    @Body()
    body: {
      bots: {
        friendCode: string;
        available: boolean;
      }[];
    },
  ) {
    this.botStatusService.report(body.bots);
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
    @Query('friendCode') friendCode?: string,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr
      ? Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200)
      : 50;
    return await this.adminService.searchJobs({ friendCode, status, limit });
  }

  @Get('jobs/:jobId/api-logs')
  @UseGuards(AdminGuard)
  async getJobApiLogs(@Param('jobId') jobId: string) {
    return await this.apiLogService.getLogsByJobId(jobId);
  }
}
