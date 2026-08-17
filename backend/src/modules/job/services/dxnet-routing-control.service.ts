import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import type {
  DxnetClaimFlow,
  DxnetRoutingControl,
  PatchDxnetRoutingControlBody,
} from '@maimai-score-hub/shared';
import {
  DxnetRoutingControlEntity,
  type DxnetRoutingControlDocument,
} from '../schemas/dxnet-routing-control.schema';

const DEFAULT_CONTROL: DxnetRoutingControl = {
  epoch: 0,
  botAllowlist: null,
  // Production stopgap: keep the automatic recent-event producer disabled.
  // Manual score updates and QR identity claims continue to use routing v2.
  enabledClaimFlows: ['manual_update', 'qr_identity'],
  claimCanaryByFlow: {
    auto_recent_event: null,
    manual_update: null,
  },
};

@Injectable()
export class DxnetRoutingControlService {
  constructor(
    @InjectModel(DxnetRoutingControlEntity.name)
    private readonly model: Model<DxnetRoutingControlDocument>,
  ) {}

  async get(): Promise<DxnetRoutingControl> {
    const row = await this.model.findOne({ key: 'singleton' }).lean();
    return row ? this.toView(row) : this.toView(DEFAULT_CONTROL);
  }

  async patch(
    body: PatchDxnetRoutingControlBody,
  ): Promise<DxnetRoutingControl> {
    const current = await this.model.findOne({ key: 'singleton' }).lean();
    if (!current) {
      if (body.expectedEpoch !== 0) {
        throw this.conflict();
      }
      try {
        const created = await this.model.create({
          key: 'singleton',
          ...this.createValues(body),
          epoch: 1,
        });
        return this.toView(created.toObject());
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw this.conflict();
        }
        throw error;
      }
    }

    const updated = await this.model.findOneAndUpdate(
      { key: 'singleton', epoch: body.expectedEpoch },
      {
        $set: this.updates(body),
        $inc: { epoch: 1 },
      },
      { new: true },
    );
    if (!updated) {
      throw this.conflict();
    }
    return this.toView(updated.toObject());
  }

  isClaimFlowEnabled(
    control: DxnetRoutingControl,
    flow: DxnetClaimFlow | null,
    friendCode: string | null,
  ): boolean {
    if (!flow || !control.enabledClaimFlows.includes(flow)) {
      return false;
    }
    if (flow === 'qr_identity') {
      return true;
    }
    const canary = control.claimCanaryByFlow[flow];
    return canary === null || canary === undefined
      ? true
      : !!friendCode && canary.includes(friendCode);
  }

  isBotAllowed(control: DxnetRoutingControl, botFriendCode: string): boolean {
    return (
      control.botAllowlist === null ||
      control.botAllowlist.includes(botFriendCode)
    );
  }

  private createValues(body: PatchDxnetRoutingControlBody) {
    return {
      botAllowlist:
        body.botAllowlist === undefined
          ? DEFAULT_CONTROL.botAllowlist
          : uniqueOrNull(body.botAllowlist),
      enabledClaimFlows:
        body.enabledClaimFlows === undefined
          ? [...DEFAULT_CONTROL.enabledClaimFlows]
          : unique(body.enabledClaimFlows),
      claimCanaryByFlow: {
        ...DEFAULT_CONTROL.claimCanaryByFlow,
        ...(body.claimCanaryByFlow?.auto_recent_event !== undefined
          ? {
              auto_recent_event: uniqueOrNull(
                body.claimCanaryByFlow.auto_recent_event,
              ),
            }
          : {}),
        ...(body.claimCanaryByFlow?.manual_update !== undefined
          ? {
              manual_update: uniqueOrNull(body.claimCanaryByFlow.manual_update),
            }
          : {}),
      },
    };
  }

  private updates(body: PatchDxnetRoutingControlBody) {
    return {
      ...(body.botAllowlist !== undefined
        ? { botAllowlist: uniqueOrNull(body.botAllowlist) }
        : {}),
      ...(body.enabledClaimFlows !== undefined
        ? { enabledClaimFlows: unique(body.enabledClaimFlows) }
        : {}),
      ...(body.claimCanaryByFlow?.auto_recent_event !== undefined
        ? {
            'claimCanaryByFlow.auto_recent_event': uniqueOrNull(
              body.claimCanaryByFlow.auto_recent_event,
            ),
          }
        : {}),
      ...(body.claimCanaryByFlow?.manual_update !== undefined
        ? {
            'claimCanaryByFlow.manual_update': uniqueOrNull(
              body.claimCanaryByFlow.manual_update,
            ),
          }
        : {}),
    };
  }

  private toView(row: Partial<DxnetRoutingControlEntity>): DxnetRoutingControl {
    return {
      epoch: row.epoch ?? 0,
      botAllowlist: row.botAllowlist ? [...row.botAllowlist] : null,
      enabledClaimFlows: [
        ...(row.enabledClaimFlows ?? DEFAULT_CONTROL.enabledClaimFlows),
      ],
      claimCanaryByFlow: {
        auto_recent_event: row.claimCanaryByFlow?.auto_recent_event ?? null,
        manual_update: row.claimCanaryByFlow?.manual_update ?? null,
      },
    };
  }

  private conflict(): ConflictException {
    return new ConflictException({ code: 'routing_control_conflict' });
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueOrNull<T>(values: T[] | null): T[] | null {
  return values === null ? null : unique(values);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}
