import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

import type { ProberExportProviderResult } from './prober-export-job.schema';

export type ProviderExportState = {
  enabled: boolean;
  lastSuccessVersion: number | null;
  lastAttemptVersion: number | null;
  status: 'idle' | 'processing' | 'failed';
  failureCount: number;
  nextAttemptAt: Date | null;
  error: string | null;
  result: ProberExportProviderResult | null;
  updatedAt: Date | null;
};

function providerDefault(): ProviderExportState {
  return {
    enabled: false,
    lastSuccessVersion: null,
    lastAttemptVersion: null,
    status: 'idle',
    failureCount: 0,
    nextAttemptAt: null,
    error: null,
    result: null,
    updatedAt: null,
  };
}

@Schema({ collection: 'prober_export_states', timestamps: true })
export class ProberExportStateEntity {
  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  ownerUserId!: Types.ObjectId | null;

  @Prop({
    type: Object,
    default: () => ({
      divingFish: providerDefault(),
      lxns: providerDefault(),
    }),
  })
  providers!: {
    divingFish: ProviderExportState;
    lxns: ProviderExportState;
  };

  @Prop({ type: String, default: null })
  claimToken!: string | null;

  @Prop({ type: Date, default: null, index: true })
  claimUntil!: Date | null;

  @Prop({ type: String, default: null })
  claimedBy!: string | null;

  @Prop({ type: Date, default: null })
  heartbeatAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  nextReconcileAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ProberExportStateDocument =
  HydratedDocument<ProberExportStateEntity>;
export const ProberExportStateSchema = SchemaFactory.createForClass(
  ProberExportStateEntity,
);

export { providerDefault };
