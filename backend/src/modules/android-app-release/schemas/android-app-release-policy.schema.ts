import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'android_app_release_policies', timestamps: true })
export class AndroidAppReleasePolicyEntity {
  @Prop({ required: true, unique: true, index: true })
  channel!: string;

  @Prop({ required: true, index: true })
  packageName!: string;

  @Prop({ required: true })
  certificateSha256!: string;

  @Prop({ required: true })
  manifestPublicKeyBase64!: string;

  @Prop({ type: [String], required: true })
  allowedDownloadHosts!: string[];

  @Prop({ required: true })
  maxApkBytes!: number;

  @Prop({ required: true, default: true })
  enabled!: boolean;
}

export type AndroidAppReleasePolicyDocument =
  HydratedDocument<AndroidAppReleasePolicyEntity>;
export const AndroidAppReleasePolicySchema = SchemaFactory.createForClass(
  AndroidAppReleasePolicyEntity,
);
