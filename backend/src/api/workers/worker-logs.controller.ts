import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import {
  WorkerLogsService,
  type WorkerLogIngestEntry,
} from '../../modules/worker-logs/services/worker-logs.service';

interface IngestBody {
  workerId?: unknown;
  entries?: unknown;
}

/**
 * Workers stream log batches here. Same guard posture as the other
 * worker-facing APIs: shared secret via X-API-Secret.
 */
@Controller('workers/logs')
export class WorkerLogIngestController {
  constructor(private readonly logs: WorkerLogsService) {}

  @Post(':kind/batches')
  @UseGuards(SharedSecretGuard)
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
