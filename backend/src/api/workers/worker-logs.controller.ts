import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { WorkerStructuredLogEntry } from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ObservabilityIngestService } from '../../modules/observability/services/observability-ingest.service';

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
  constructor(private readonly observability: ObservabilityIngestService) {}

  @Post(':kind/batches')
  @UseGuards(SharedSecretGuard)
  ingest(@Param('kind') kind: string, @Body() body: IngestBody) {
    if (kind !== 'sdgb' && kind !== 'dxnet') {
      throw new BadRequestException('kind must be one of: sdgb, dxnet');
    }
    const workerId =
      typeof body.workerId === 'string' && body.workerId.trim()
        ? body.workerId.trim()
        : null;
    if (!workerId) {
      throw new BadRequestException('workerId required');
    }
    if (!Array.isArray(body.entries)) {
      throw new BadRequestException('entries must be an array');
    }
    const clickhouseResult = this.observability.recordStructuredLogs({
      service: `${kind}-worker`,
      workerKind: kind,
      workerId,
      entries: body.entries as WorkerStructuredLogEntry[],
    });
    return clickhouseResult;
  }
}
