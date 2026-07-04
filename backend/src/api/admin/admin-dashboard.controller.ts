import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminJobMetricsService } from '../../modules/admin/services/admin-job-metrics.service';
import { AdminSummaryService } from '../../modules/admin/services/admin-summary.service';

@Controller('admin/dashboard')
@UseGuards(SharedSecretGuard)
export class AdminDashboardController {
  constructor(
    private readonly summaryService: AdminSummaryService,
    private readonly jobMetricsService: AdminJobMetricsService,
  ) {}

  @Get('stats')
  async getStats() {
    return this.summaryService.getStats();
  }

  @Get('job-stats')
  async getJobStats() {
    return await this.jobMetricsService.getJobStats();
  }

  @Get('job-trend')
  async getJobTrend(@Query('hours') hoursStr?: string) {
    const hours = hoursStr
      ? Math.min(Math.max(parseInt(hoursStr, 10) || 24, 1), 720)
      : 24;
    return await this.jobMetricsService.getJobTrend(hours);
  }

  @Get('job-error-stats')
  async getJobErrorStats() {
    return await this.jobMetricsService.getJobErrorStats();
  }
}
