import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AddApiLogsBodySchema,
  ExternalApiCallBatchBodySchema,
  type AddApiLogsBody,
  type ExternalApiCallBatchBody,
} from '@maimai-score-hub/shared';

import {
  JobApiLogService,
  type ApiLogEntry,
} from '../../modules/job/api-log/api-log.service';
import { ObservabilityIngestService } from '../../modules/observability/services/observability-ingest.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('workers/dxnet/jobs')
@UseGuards(SharedSecretGuard)
export class WorkerDxnetApiLogController {
  constructor(
    private readonly apiLog: JobApiLogService,
    private readonly observability: ObservabilityIngestService,
  ) {}

  /**
   * Worker 上报 API 调用日志
   */
  @Post(':jobId/api-logs')
  @HttpCode(201)
  async addApiLogs(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(AddApiLogsBodySchema)) body: AddApiLogsBody,
  ) {
    const logs: ApiLogEntry[] = [];
    for (let i = 0; i < body.logs.length; i++) {
      const entry = body.logs[i];
      logs.push({
        url: entry.url,
        method: entry.method,
        statusCode: entry.statusCode,
        bodySize: typeof entry.bodySize === 'number' ? entry.bodySize : null,
      });
    }

    await this.apiLog.saveLogs(jobId, logs);
    this.observability.recordExternalApiCalls({
      jobId,
      workerKind: 'dxnet',
      calls: logs.map((log) => ({
        target: 'maimai_dxnet',
        apiGroup: 'legacy',
        method: log.method,
        urlGroup: toLegacyUrlGroup(log.url),
        statusCode: log.statusCode,
        bodySize: log.bodySize ?? null,
      })),
    });
    return { success: true };
  }

  @Post(':jobId/api-calls')
  @HttpCode(201)
  addApiCalls(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(ExternalApiCallBatchBodySchema))
    body: ExternalApiCallBatchBody,
  ) {
    return this.observability.recordExternalApiCalls({
      jobId,
      workerKind: 'dxnet',
      calls: body.calls,
    });
  }
}

function toLegacyUrlGroup(url: string): string {
  if (url.includes('friendGenreVs')) {
    return 'maimai.friend.genre_vs';
  }
  if (url.includes('friendDetail')) {
    return 'maimai.friend.detail';
  }
  if (url.includes('friend')) {
    return 'maimai.friend.pages';
  }
  return 'maimai.dxnet.unknown';
}
