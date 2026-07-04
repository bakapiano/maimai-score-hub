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
  getRealtimeOverview(
    @Query('env') env?: string,
    @Query('recentMinutes') recentMinutes?: string,
  ) {
    return this.observability.getRealtimeOverview(env, recentMinutes);
  }

  @Get('realtime/worker-groups')
  getRealtimeWorkerGroups(
    @Query('env') env?: string,
    @Query('window') window?: string,
  ) {
    return this.observability.getRealtimeWorkerGroups(env, window);
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
    @Query('workerKind') workerKind?: string,
    @Query('workerId') workerId?: string,
    @Query('level') level?: string,
    @Query('jobId') jobId?: string,
    @Query('q') q?: string,
    @Query('sinceMinutes') sinceMinutes?: string,
    @Query('limit') limit?: string,
  ) {
    return this.observability.getStructuredLogs({
      environment: env,
      service,
      workerKind,
      workerId,
      level,
      jobId,
      q,
      sinceMinutes,
      limit,
    });
  }

  @Get('history/log-workers')
  getStructuredLogWorkers(
    @Query('env') env?: string,
    @Query('sinceMinutes') sinceMinutes?: string,
  ) {
    return this.observability.getStructuredLogWorkers({
      environment: env,
      sinceMinutes,
    });
  }

  @Get('jobs/:jobId/debug')
  getJobDebug(@Param('jobId') jobId: string, @Query('env') env?: string) {
    return this.observability.getJobDebug(jobId, env);
  }
}
