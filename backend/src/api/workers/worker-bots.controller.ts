import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ReportBotStatusBodySchema,
  type ReportBotStatusBody,
} from '@maimai-score-hub/shared';

import { BotFriendSnapshotService } from '../../modules/bots/services/bot-friend-snapshot.service';
import { BotStatusService } from '../../modules/bots/services/bot-status.service';
import { UsersService } from '../../modules/users/services/users.service';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('workers/bots')
export class WorkerBotStatusController {
  constructor(
    private readonly botStatusService: BotStatusService,
    private readonly botFriendSnapshotService: BotFriendSnapshotService,
    private readonly usersService: UsersService,
  ) {}

  /** Worker 上报 Bot 状态（X-API-Secret 校验）。 */
  @Post('status')
  @UseGuards(SharedSecretGuard)
  async reportBotStatus(
    @Body(new ZodValidationPipe(ReportBotStatusBodySchema))
    body: ReportBotStatusBody,
  ) {
    await this.botStatusService.report(body.bots);
    // Side-channel: any bot row that included a `friends` array also
    // gets full-overwritten into bot_statuses.friends for the QR-login
    // reverse-map flow. Workers send this opportunistically on every tick.
    // Same friends array also drives user.profile auto-population so QR-
    // login users get an avatar/title/etc without an extra RPC.
    const allFriends: NonNullable<(typeof body.bots)[0]['friends']> = [];
    for (const b of body.bots) {
      if (Array.isArray(b.friends)) {
        const friendsUpdatedAt = parseDateOrUndefined(b.friendsUpdatedAt);
        await this.botFriendSnapshotService.report(
          b.friendCode,
          b.friends.map((f) => ({
            friendCode: f.friendCode,
            userName: f.userName ?? null,
            rating: f.rating ?? null,
          })),
          friendsUpdatedAt,
        );
        allFriends.push(...b.friends);
      }
    }
    if (allFriends.length > 0) {
      // Best-effort: profile patching shouldn't fail the heartbeat.
      void this.usersService
        .patchProfilesFromFriendList(allFriends)
        .catch(() => {});
    }
    return { ok: true };
  }
}

function parseDateOrUndefined(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
