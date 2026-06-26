import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  UpdateSystemSettingsBodySchema,
  type UpdateSystemSettingsBody,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { SystemSettingsService } from '../../modules/system-settings/system-settings.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin/settings')
@UseGuards(SharedSecretGuard)
export class AdminSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  async getSystemSettings() {
    return this.systemSettingsService.get();
  }

  @Patch()
  async updateSystemSettings(
    @Body(new ZodValidationPipe(UpdateSystemSettingsBodySchema))
    body: UpdateSystemSettingsBody,
  ) {
    if (typeof body.cabinetOnlyMode === 'boolean') {
      return this.systemSettingsService.setCabinetOnlyMode(
        body.cabinetOnlyMode,
      );
    }
    return this.systemSettingsService.get();
  }
}
