import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  SdgbWorkerIncidentSchema,
  type SdgbWorkerIncident,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbWorkerIncidentService } from '../../modules/sdgb-worker/services/sdgb-worker-incident.service';

@Controller('workers/sdgb')
@UseGuards(SharedSecretGuard)
export class WorkerSdgbControlController {
  constructor(private readonly incidents: SdgbWorkerIncidentService) {}

  @Post('incidents')
  @HttpCode(HttpStatus.OK)
  async incident(
    @Body(new ZodValidationPipe(SdgbWorkerIncidentSchema))
    body: SdgbWorkerIncident,
  ) {
    return this.incidents.report(body);
  }
}
