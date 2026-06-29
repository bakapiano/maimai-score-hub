import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  SearchJobsQuerySchema,
  type SearchJobsQuery,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminJobQueryService } from '../../modules/admin/services/admin-job-query.service';
import { JobService } from '../../modules/job/services/job.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin/dxnet-jobs')
@UseGuards(SharedSecretGuard)
export class AdminDxnetJobsController {
  constructor(
    private readonly adminJobQueryService: AdminJobQueryService,
    private readonly jobService: JobService,
  ) {}

  @Get('active')
  async getActiveJobs() {
    return await this.adminJobQueryService.getActiveJobs();
  }

  @Get()
  async searchJobs(
    @Query(new ZodValidationPipe(SearchJobsQuerySchema)) query: SearchJobsQuery,
  ) {
    return await this.adminJobQueryService.searchJobs({
      friendCode: query.friendCode,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
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
