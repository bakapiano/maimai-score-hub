import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  PatchDxnetRoutingControlBodySchema,
  type PatchDxnetRoutingControlBody,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DxnetRoutingControlService } from '../../modules/job/services/dxnet-routing-control.service';

@Controller('admin/dxnet-routing-control')
@UseGuards(SharedSecretGuard)
export class AdminDxnetRoutingControlController {
  constructor(private readonly control: DxnetRoutingControlService) {}

  @Get()
  async get() {
    return this.control.get();
  }

  @Patch()
  async patch(
    @Body(new ZodValidationPipe(PatchDxnetRoutingControlBodySchema))
    body: PatchDxnetRoutingControlBody,
  ) {
    return this.control.patch(body);
  }
}
