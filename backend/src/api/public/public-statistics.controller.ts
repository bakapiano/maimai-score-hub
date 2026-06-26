import { Controller, Get } from '@nestjs/common';

import { JobService } from '../../modules/job/services/job.service';

@Controller('statistics')
export class PublicStatisticsController {
  constructor(private readonly jobs: JobService) {}

  @Get()
  async getStatistics() {
    return {
      dxnetJobs: await this.jobs.getRecentStats(),
    };
  }
}
