import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSdgbMaintenanceRequestSchema,
  SdgbHookObservationSchema,
  type CreateSdgbMaintenanceRequest,
  type SdgbHookObservation,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SdgbMaintenanceService } from '../../modules/sdgb-worker/services/sdgb-maintenance.service';

@Controller('internal/sdgb/maintenance-runs')
@UseGuards(SharedSecretGuard)
export class WorkerSdgbMaintenanceController {
  constructor(private readonly maintenance: SdgbMaintenanceService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body(new ZodValidationPipe(CreateSdgbMaintenanceRequestSchema))
    body: CreateSdgbMaintenanceRequest,
  ) {
    return this.maintenance.create(body);
  }

  @Get(':requestId')
  async get(@Param('requestId') requestId: string) {
    return this.maintenance.get(requestId);
  }

  @Post(':requestId/hook-observation')
  async observation(
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(SdgbHookObservationSchema))
    body: SdgbHookObservation,
  ) {
    return this.maintenance.observe(requestId, body);
  }
}
