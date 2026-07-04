import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ExternalApiCallBatchBodySchema,
  type ExternalApiCallBatchBody,
} from '@maimai-score-hub/shared';

import { ObservabilityIngestService } from '../../modules/observability/services/observability-ingest.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('workers/dxnet/jobs')
@UseGuards(SharedSecretGuard)
export class WorkerDxnetApiCallsController {
  constructor(private readonly observability: ObservabilityIngestService) {}

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
