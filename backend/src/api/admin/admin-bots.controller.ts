import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  UpdateBotCabinetUserIdBodySchema,
  UpdateBotRemarkBodySchema,
  type UpdateBotCabinetUserIdBody,
  type UpdateBotRemarkBody,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { BotStatusService } from '../../modules/bots/services/bot-status.service';
import { SdgbJobDispatcher } from '../../modules/sdgb-worker/services/sdgb-job.dispatcher';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin/bots')
@UseGuards(SharedSecretGuard)
export class AdminBotsController {
  constructor(
    private readonly botStatusService: BotStatusService,
    private readonly sdgbDispatcher: SdgbJobDispatcher,
  ) {}

  @Get()
  async getBotStatus() {
    return this.botStatusService.getAll();
  }

  @Patch(':friendCode/remark')
  async updateBotRemark(
    @Param('friendCode') friendCode: string,
    @Body(new ZodValidationPipe(UpdateBotRemarkBodySchema))
    body: UpdateBotRemarkBody,
  ) {
    await this.botStatusService.updateRemark(friendCode, body.remark);
    return { ok: true };
  }

  /**
   * Configure the cabinet (sdgb) userId for a bot. The auto-update flow uses
   * this id as `userId1` of UserFriendRegistApi when adding a user as the
   * bot's rival on the cabinet side.
   */
  @Patch(':friendCode/cabinet-user-id')
  async updateBotCabinetUserId(
    @Param('friendCode') friendCode: string,
    @Body(new ZodValidationPipe(UpdateBotCabinetUserIdBodySchema))
    body: UpdateBotCabinetUserIdBody,
  ) {
    await this.botStatusService.setCabinetUserId(
      friendCode,
      body.cabinetUserId,
    );
    return { ok: true };
  }

  /**
   * Remove a bot row from the bot_statuses collection.
   * Use case: bot's worker is permanently dead and the row clutters
   * admin UI. If the worker is actually still alive its next 60s
   * heartbeat will recreate the row, so this is safe — there's no
   * "blacklist" semantic.
   */
  @Delete(':friendCode')
  async removeBot(@Param('friendCode') friendCode: string) {
    if (!friendCode || !/^\d+$/.test(friendCode)) {
      throw new BadRequestException('friendCode must be a numeric string');
    }
    const result = await this.botStatusService.remove(friendCode);
    return { ok: true, ...result };
  }

  /**
   * Bind a bot's cabinetUserId by scanning the bot's card QR. Routes
   * through sdgb-worker (scan_qr job) so the cabinet contract / crypto
   * stays in one place.
   */
  @Post(':friendCode/cabinet/bind-qr')
  async bindBotCabinetQr(
    @Param('friendCode') friendCode: string,
    @Body() body: { qrCode?: unknown },
  ) {
    const qrCode = typeof body?.qrCode === 'string' ? body.qrCode.trim() : '';
    if (!qrCode) {
      throw new BadRequestException('qrCode (string) required');
    }
    try {
      const result = await this.sdgbDispatcher.scanQr(
        { qrCode },
        { tag: `admin-bot-bind:${friendCode}`, timeoutMs: 120_000 },
      );
      await this.botStatusService.setCabinetUserId(
        friendCode,
        result.cabinetUserId,
      );
      return {
        ok: true,
        friendCode,
        cabinetUserId: result.cabinetUserId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`扫码绑定失败: ${message}`);
    }
  }
}
