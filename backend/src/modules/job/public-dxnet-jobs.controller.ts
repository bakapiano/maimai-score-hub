import { Controller, Get, Param } from '@nestjs/common';

import { JobService } from './job.service';

@Controller('dxnet-jobs')
export class PublicDxnetJobsController {
  constructor(private readonly jobs: JobService) {}

  @Get('stats/recent')
  async getRecentStats() {
    return this.jobs.getRecentStats();
  }

  @Get(':jobId')
  async get(@Param('jobId') jobId: string) {
    return this.jobs.get(jobId);
  }
}
