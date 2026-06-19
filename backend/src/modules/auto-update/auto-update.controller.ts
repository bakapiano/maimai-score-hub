import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
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
   * Lightweight admin overview: only expose the enabled auto-update user
   * count. The detailed per-user job lookup is intentionally avoided because
   * it fans out into expensive jobs/sdgb_jobs aggregations.
   */
  @Get('users')
  @UseGuards(AdminGuard)
  async listUsers() {
    return this.scheduler.getAutoUpdateUserCount();
  }

  /**
   * Per-user job timeline (sdgb hash checks + dxnet idle_update_score
   * jobs, merged by createdAt desc). Used by the admin UI to verify that
   * the hash-diff guard is working — i.e. a hash_check entry with the
   * same hash should NOT be followed by an update_job.
   */
  @Get('users/:friendCode/history')
  @UseGuards(AdminGuard)
  async getUserHistory(
    @Param('friendCode') friendCode: string,
    @Query('limit') limitStr?: string,
  ) {
    if (!/^\d+$/.test(friendCode)) {
      throw new BadRequestException('friendCode must be a numeric string');
    }
    const limit = Math.min(
      200,
      Math.max(1, limitStr ? parseInt(limitStr, 10) || 30 : 30),
    );
    return this.scheduler.getUserJobHistory(friendCode, limit);
  }
}
