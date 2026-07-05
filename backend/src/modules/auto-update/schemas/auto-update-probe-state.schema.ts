import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type AutoUpdateTier = 'hot' | 'warm' | 'cold';
export type AutoUpdateFcfsReason =
  'rival_hash_changed' | 'map_delta' | 'manual';

@Schema({ collection: 'auto_update_probe_states', timestamps: true })
export class AutoUpdateProbeStateEntity {
  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ required: true, index: true })
  cabinetUserId!: number;

  @Prop({ type: Boolean, default: true, index: true })
  enabled!: boolean;

  @Prop({ type: String, default: 'cold', index: true })
  tier!: AutoUpdateTier;

  @Prop({ type: String, default: null })
  lastRivalHash!: string | null;

  @Prop({ type: Date, default: null })
  lastRivalProbeAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  nextRivalProbeAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastScoreChangedAt!: Date | null;

  @Prop({ type: String, default: null })
  mapFingerprint!: string | null;

  @Prop({ type: Number, default: null })
  mapDistanceSum!: number | null;

  @Prop({ type: Date, default: null })
  lastMapProbeAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastMapDeltaAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  nextMapProbeAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastRecentEventAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  nextRecentEventAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastAutoUpdateActivityAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  pendingFullUpdateAt!: Date | null;

  @Prop({ type: String, default: null })
  lastRecentEventFingerprint!: string | null;

  @Prop({ type: String, default: null, index: true })
  pendingRecentEventReason!: AutoUpdateFcfsReason | null;

  @Prop({ type: Date, default: null })
  pendingRecentEventRequestedAt!: Date | null;

  @Prop({ type: Number, default: 0 })
  pendingRecentEventCount!: number;

  @Prop({ type: Number, default: 0 })
  rivalErrorCount!: number;

  @Prop({ type: Number, default: 0 })
  mapErrorCount!: number;

  @Prop({ type: Number, default: 0 })
  recentErrorCount!: number;

  @Prop({ type: Date, default: null, index: true })
  backoffUntil!: Date | null;

  @Prop({ type: Number, default: 1 })
  habitMultiplier!: number;

  @Prop({ type: Number, default: 1 })
  loadMultiplier!: number;

  @Prop({ type: String, default: 'rival-first-v1' })
  schedulerVersion!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AutoUpdateProbeStateDocument =
  HydratedDocument<AutoUpdateProbeStateEntity>;
export const AutoUpdateProbeStateSchema = SchemaFactory.createForClass(
  AutoUpdateProbeStateEntity,
);

AutoUpdateProbeStateSchema.index(
  { enabled: 1, nextRivalProbeAt: 1, tier: 1 },
  { name: 'due_rival_probe' },
);
AutoUpdateProbeStateSchema.index(
  { enabled: 1, nextMapProbeAt: 1, tier: 1 },
  { name: 'due_map_probe' },
);
AutoUpdateProbeStateSchema.index(
  { enabled: 1, pendingRecentEventReason: 1, nextRecentEventAt: 1 },
  { name: 'due_pending_fcfs' },
);
AutoUpdateProbeStateSchema.index(
  { enabled: 1, pendingFullUpdateAt: 1 },
  { name: 'due_pending_full_update' },
);
