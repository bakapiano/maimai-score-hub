import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('job-stats')
  async getJobStats() {
    return await this.adminService.getJobStats();
  }

  @Get('job-trend')
  async getJobTrend(@Query('hours') hoursStr?: string) {
    const hours = hoursStr
      ? Math.min(Math.max(parseInt(hoursStr, 10) || 24, 1), 720)
      : 24;
    return await this.adminService.getJobTrend(hours);
  }

  @Get('job-error-stats')
  async getJobErrorStats() {
    return await this.adminService.getJobErrorStats();
  }

  @Get('users')
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }

  @Post('sync-covers')
  async syncCovers() {
    const result = await this.adminService.syncCovers();
    return { ok: true, ...result };
  }

  @Post('sync-music')
  async syncMusic() {
    const result = await this.adminService.syncMusic();
    return { ok: true, ...result };
  }

  @Get('active-jobs')
  async getActiveJobs() {
    return await this.adminService.getActiveJobs();
  }
}
