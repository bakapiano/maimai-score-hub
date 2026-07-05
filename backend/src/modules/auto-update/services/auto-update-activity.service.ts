import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { AutoUpdateProbeStateEntity } from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateSchedulerTimingService } from './auto-update-scheduler-timing.service';

const SCHEDULER_VERSION = 'rival-first-v1';

@Injectable()
export class AutoUpdateActivityService {
  constructor(
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly stateModel: Model<AutoUpdateProbeStateEntity>,
    private readonly timing: AutoUpdateSchedulerTimingService,
  ) {}

  async recordActivitySignal(input: {
    friendCode: string;
    at: Date;
  }): Promise<void> {
    await this.stateModel.updateOne(
      { friendCode: input.friendCode, enabled: true },
      {
        $set: {
          lastAutoUpdateActivityAt: input.at,
          pendingFullUpdateAt: this.nextSettledFullUpdateAt(input.at),
          schedulerVersion: SCHEDULER_VERSION,
        },
      },
    );
  }

  async recordRecentEventFingerprint(input: {
    friendCode: string;
    fingerprint: string;
    at: Date;
  }): Promise<boolean> {
    const updated = await this.stateModel.updateOne(
      {
        friendCode: input.friendCode,
        enabled: true,
        $or: [
          { lastRecentEventFingerprint: { $exists: false } },
          { lastRecentEventFingerprint: null },
          { lastRecentEventFingerprint: { $ne: input.fingerprint } },
        ],
      },
      {
        $set: {
          lastRecentEventFingerprint: input.fingerprint,
          lastAutoUpdateActivityAt: input.at,
          pendingFullUpdateAt: this.nextSettledFullUpdateAt(input.at),
          schedulerVersion: SCHEDULER_VERSION,
        },
      },
    );
    return (updated.modifiedCount ?? 0) > 0;
  }

  private nextSettledFullUpdateAt(at: Date): Date {
    return new Date(at.getTime() + this.timing.settledFullUpdateDelayMs);
  }
}
