import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JobPatchBodySchema } from '@maimai-score-hub/shared';

import { JobService } from '../../modules/job/services/job.service';
import { QrLoginService } from '../../modules/auth/services/qr-login.service';
import { UsersService } from '../../modules/users/services/users.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { JobPatchBody } from '../../modules/job/job.types';

@Controller('workers/dxnet')
@UseGuards(SharedSecretGuard)
export class WorkerDxnetJobsController {
  constructor(
    private readonly jobs: JobService,
    private readonly users: UsersService,
    private readonly qrLogin: QrLoginService,
  ) {}

  @Get('bots/:botUserFriendCode/active-friend-codes')
  async getActiveFriendCodes(
    @Param('botUserFriendCode') botUserFriendCode: string,
  ) {
    return this.jobs.getActiveFriendCodesByBot(botUserFriendCode);
  }

  @Get('qr-login/rival-names')
  async getRunningQrLoginRivalNames() {
    return this.qrLogin.getRunningRivalNames();
  }

  @Get('jobs/:jobId')
  async get(@Param('jobId') jobId: string) {
    return this.jobs.get(jobId);
  }

  @Patch('jobs/:jobId')
  async patch(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(JobPatchBodySchema)) body: JobPatchBody,
  ) {
    return this.jobs.patch(jobId, body);
  }

  @Post('users/activity')
  @HttpCode(200)
  async getUsersActivity(@Body() body: { friendCodes?: unknown }): Promise<
    {
      friendCode: string;
      lastActiveAt: string | null;
      cabinetUserId: number | null;
    }[]
  > {
    if (!Array.isArray(body.friendCodes)) {
      throw new BadRequestException('friendCodes must be an array');
    }
    const friendCodes = body.friendCodes.filter(
      (value): value is string => typeof value === 'string',
    );
    const rows = await this.users.getActivityByFriendCodes(friendCodes);
    return rows.map((row) => ({
      friendCode: row.friendCode,
      lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
      cabinetUserId: row.cabinetUserId,
    }));
  }
}
