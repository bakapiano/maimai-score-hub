import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

import type {
  DxnetClaimFlow,
  DxnetRoutingControl,
} from '@maimai-score-hub/shared';

@Schema({ collection: 'dxnet_routing_control', versionKey: false })
export class DxnetRoutingControlEntity implements DxnetRoutingControl {
  @Prop({ required: true, default: 'singleton' })
  key!: 'singleton';

  @Prop({ required: true, type: Number, default: 0 })
  epoch!: number;

  @Prop({ type: [String], default: null })
  botAllowlist!: string[] | null;

  @Prop({ type: [String], default: [] })
  enabledClaimFlows!: DxnetClaimFlow[];

  @Prop({ type: Object, default: {} })
  claimCanaryByFlow!: {
    auto_recent_event?: string[] | null;
    manual_update?: string[] | null;
  };
}

export type DxnetRoutingControlDocument =
  HydratedDocument<DxnetRoutingControlEntity>;
export const DxnetRoutingControlSchema = SchemaFactory.createForClass(
  DxnetRoutingControlEntity,
);
DxnetRoutingControlSchema.index(
  { key: 1 },
  { name: 'routing_control_key_unique', unique: true },
);
