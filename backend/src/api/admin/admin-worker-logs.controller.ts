import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { WorkerLogsService } from '../../modules/worker-logs/services/worker-logs.service';

@Controller('admin/worker-logs')
@UseGuards(SharedSecretGuard)
export class AdminWorkerLogsController {
  constructor(private readonly logs: WorkerLogsService) {}

  @Get()
  async list(
    @Query('workerKind') workerKind?: string,
    @Query('workerId') workerId?: string,
    @Query('level') level?: string,
    @Query('q') q?: string,
    @Query('sinceMinutes') sinceMinutes?: string,
    @Query('limit') limitStr?: string,
  ) {
    const since = sinceMinutes
      ? new Date(
          Date.now() -
            Math.max(1, Math.min(24 * 60, parseInt(sinceMinutes, 10) || 60)) *
              60 *
              1000,
        )
      : undefined;
    return this.logs.list({
      workerKind:
        workerKind === 'sdgb' || workerKind === 'dxnet'
          ? workerKind
          : undefined,
      workerId: workerId?.trim() || undefined,
      level:
        level === 'log' || level === 'warn' || level === 'error'
          ? level
          : undefined,
      q,
      since,
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
    });
  }

  @Get('workers')
  async workers() {
    return this.logs.listWorkerIds();
  }
}
