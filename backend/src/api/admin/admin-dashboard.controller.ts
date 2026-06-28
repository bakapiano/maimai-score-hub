import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminService } from '../../modules/admin/services/admin.service';

@Controller('admin/dashboard')
@UseGuards(SharedSecretGuard)
export class AdminDashboardController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('job-stats')
  async getJobStats() {
    return await this.adminService.getJobStats();
  }

  /**
   * Aggregated dashboard for /admin/dashboard/auto-update-metrics.
   * window: '24h' (5min buckets) or '7d' (1h buckets).
   */
  @Get('auto-update-metrics')
  async getAutoUpdateMetrics(@Query('window') window?: string) {
    const w: '24h' | '7d' = window === '7d' ? '7d' : '24h';
    return this.adminService.getAutoUpdateMetrics(w);
  }

  /**
   * Aggregated stats for prober exports across all triggers.
   * Source: prober_export_jobs.
   */
  @Get('prober-export-metrics')
  async getProberExportMetrics(@Query('window') window?: string) {
    const w: '24h' | '7d' = window === '7d' ? '7d' : '24h';
    return this.adminService.getProberExportMetrics(w);
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
}
