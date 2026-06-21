import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard';
import { WorkerAuthGuard } from '../../common/guards/worker-auth.guard';
import {
  WorkerLogsService,
  type WorkerLogIngestEntry,
} from './worker-logs.service';

interface IngestBody {
  workerId?: unknown;
  entries?: unknown;
}

/**
 * Workers stream log batches here. Same guard posture as the other
 * worker-facing APIs: shared secret when ADMIN_PASSWORD is configured.
 */
@Controller('workers/logs')
export class WorkerLogIngestController {
  constructor(private readonly logs: WorkerLogsService) {}

  @Post(':kind/batches')
  @UseGuards(WorkerAuthGuard)
  async ingest(@Param('kind') kind: string, @Body() body: IngestBody) {
    if (kind !== 'sdgb' && kind !== 'dxnet') {
      throw new BadRequestException('kind must be one of: sdgb, dxnet');
    }
    const workerId =
      typeof body.workerId === 'string' && body.workerId.trim()
        ? body.workerId.trim()
        : null;
    if (!workerId) throw new BadRequestException('workerId required');
    if (!Array.isArray(body.entries)) {
      throw new BadRequestException('entries must be an array');
    }
    return this.logs.ingest(
      kind,
      workerId,
      body.entries as WorkerLogIngestEntry[],
    );
  }
}

@Controller('admin/worker-logs')
@UseGuards(AdminGuard)
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
