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
  type AddApiLogsBody,
} from '@maimai-score-hub/shared';

import {
  JobApiLogService,
  type ApiLogEntry,
} from '../../modules/job/api-log/api-log.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('workers/dxnet/jobs')
@UseGuards(SharedSecretGuard)
export class WorkerDxnetApiLogController {
  constructor(private readonly apiLog: JobApiLogService) {}

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
    return { success: true };
  }
}
