import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { SdgbJobService } from '../../modules/sdgb-worker/services/sdgb-job.service';

@Controller('admin/sdgb')
@UseGuards(SharedSecretGuard)
export class AdminSdgbController {
  constructor(private readonly sdgbJobService: SdgbJobService) {}

  /**
   * sdgb-worker dashboard data: heartbeats, queue depth, recent jobs.
   * Frontend admin portal polls this every few seconds.
   */
  @Get('status')
  async getSdgbWorkerStatus() {
    return this.sdgbJobService.getAdminStatus();
  }

  /**
   * Paginated, filterable sdgb job list. Query params: jobType, status,
   * tag (substring), page, pageSize.
   */
  @Get('jobs')
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
      opts.status = status as 'queued' | 'processing' | 'completed' | 'failed';
    }
    return this.sdgbJobService.listJobs(opts);
  }
}
