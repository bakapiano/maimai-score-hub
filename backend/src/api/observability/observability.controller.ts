import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  AnalyticsBatchBodySchema,
  RumBatchBodySchema,
  type AnalyticsBatchBody,
  type RumBatchBody,
} from '@maimai-score-hub/shared';

import { ObservabilityIngestService } from '../../modules/observability/services/observability-ingest.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('observability')
export class ObservabilityController {
  constructor(private readonly ingest: ObservabilityIngestService) {}

  @Post('rum')
  @HttpCode(202)
  ingestRum(
    @Body(new ZodValidationPipe(RumBatchBodySchema)) body: RumBatchBody,
  ) {
    return this.ingest.recordFrontendRum(body.events);
  }

  @Post('events')
  @HttpCode(202)
  ingestEvents(
    @Body(new ZodValidationPipe(AnalyticsBatchBodySchema))
    body: AnalyticsBatchBody,
  ) {
    return this.ingest.recordAnalyticsEvents(body.events);
  }
}
