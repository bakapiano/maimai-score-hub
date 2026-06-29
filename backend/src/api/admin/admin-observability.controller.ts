import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { ObservabilityQueryService } from '../../modules/observability/services/observability-query.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';

@Controller('admin')
@UseGuards(SharedSecretGuard)
export class AdminObservabilityController {
  constructor(private readonly observability: ObservabilityQueryService) {}

  @Get('observability/status')
  getStatus() {
    return this.observability.getStatus();
  }

  @Get('realtime/overview')
  getRealtimeOverview(@Query('env') env?: string) {
    return this.observability.getRealtimeOverview(env);
  }

  @Get('history/api')
  getApiHistory(@Query('env') env?: string, @Query('window') window?: string) {
    return this.observability.getApiHistory(env, window);
  }

  @Get('history/rum')
  getRumHistory(@Query('env') env?: string, @Query('window') window?: string) {
    return this.observability.getRumHistory(env, window);
  }

  @Get('history/analytics')
  getAnalyticsHistory(
    @Query('env') env?: string,
    @Query('window') window?: string,
  ) {
    return this.observability.getAnalyticsHistory(env, window);
  }

  @Get('history/workers')
  getWorkersHistory(
    @Query('env') env?: string,
    @Query('window') window?: string,
  ) {
    return this.observability.getWorkersHistory(env, window);
  }

  @Get('history/logs')
  getStructuredLogs(
    @Query('env') env?: string,
    @Query('service') service?: string,
    @Query('workerId') workerId?: string,
    @Query('level') level?: string,
    @Query('jobId') jobId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.observability.getStructuredLogs({
      environment: env,
      service,
      workerId,
      level,
      jobId,
      q,
      limit,
    });
  }

  @Get('jobs/:jobId/debug')
  getJobDebug(@Param('jobId') jobId: string, @Query('env') env?: string) {
    return this.observability.getJobDebug(jobId, env);
  }
}
