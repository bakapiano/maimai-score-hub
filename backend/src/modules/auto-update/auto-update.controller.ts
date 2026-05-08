import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard';
import { AutoUpdateSchedulerService } from './auto-update-scheduler.service';

@Controller('auto-update')
export class AutoUpdateController {
  constructor(private readonly scheduler: AutoUpdateSchedulerService) {}

  /**
   * Admin-triggered manual sweep. Useful for testing the flow without
   * waiting for the next AUTO_UPDATE_CRON tick.
   */
  @Post('run')
  @UseGuards(AdminGuard)
  async run(@Body() _body: unknown) {
    return this.scheduler.runSweep();
  }
}
