import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

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

  /**
   * Admin support tool: force a refresh for one specific user, regardless
   * of whether their score hash actually changed. Skips the hash check.
   */
  @Post('trigger/:friendCode')
  @UseGuards(AdminGuard)
  async triggerByFriendCode(@Param('friendCode') friendCode: string) {
    if (!friendCode || !/^\d+$/.test(friendCode)) {
      throw new BadRequestException('friendCode must be a numeric string');
    }
    try {
      const result = await this.scheduler.triggerByFriendCode(friendCode);
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(message);
    }
  }

  /**
   * Admin overview: list every user that has autoUpdate=true plus their
   * latest hash-check + idle_update_score job, so the admin portal can show
   * "who is using auto-update and how recent was the last refresh".
   */
  @Get('users')
  @UseGuards(AdminGuard)
  async listUsers() {
    return this.scheduler.listAutoUpdateUsers();
  }
}
