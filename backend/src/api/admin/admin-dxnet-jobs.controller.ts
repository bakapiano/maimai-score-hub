import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  SearchJobsQuerySchema,
  type SearchJobsQuery,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminService } from '../../modules/admin/services/admin.service';
import { JobApiLogService } from '../../modules/job/api-log/api-log.service';
import { JobService } from '../../modules/job/services/job.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin/dxnet-jobs')
@UseGuards(SharedSecretGuard)
export class AdminDxnetJobsController {
  constructor(
    private readonly adminService: AdminService,
    private readonly apiLogService: JobApiLogService,
    private readonly jobService: JobService,
  ) {}

  @Get('active')
  async getActiveJobs() {
    return await this.adminService.getActiveJobs();
  }

  @Get()
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

  @Get(':jobId/api-logs')
  async getJobApiLogs(@Param('jobId') jobId: string) {
    return await this.apiLogService.getLogsByJobId(jobId);
  }

  /**
   * 清理创建时间在七天之前的所有 job
   */
  @Post('cleanup')
  async cleanupJobs() {
    const deletedCount = await this.jobService.cleanupOldJobs();
    return { ok: true, deletedCount };
  }
}
