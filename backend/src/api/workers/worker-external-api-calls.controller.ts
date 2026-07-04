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

@Controller('workers')
@UseGuards(SharedSecretGuard)
export class WorkerExternalApiCallsController {
  constructor(private readonly observability: ObservabilityIngestService) {}

  @Post(':kind/external-api-calls')
  @HttpCode(201)
  ingestExternalApiCalls(
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(ExternalApiCallBatchBodySchema))
    body: ExternalApiCallBatchBody,
  ) {
    return this.observability.recordExternalApiCalls({
      workerKind: kind,
      calls: body.calls.map((call) => ({
        ...call,
        workerKind: call.workerKind ?? kind,
      })),
    });
  }
}
