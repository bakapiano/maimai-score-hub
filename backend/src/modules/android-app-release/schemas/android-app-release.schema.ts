import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'android_app_releases', timestamps: true })
export class AndroidAppReleaseEntity {
  @Prop({ required: true, unique: true, index: true })
  releaseId!: string;

  @Prop({ required: true, index: true })
  channel!: string;

  @Prop({ required: true, index: true })
  packageName!: string;

  @Prop({ required: true })
  versionCode!: number;

  @Prop({ required: true })
  versionName!: string;

  @Prop({ required: true })
  requiredBridgeApiVersion!: number;

  @Prop({ required: true })
  minSdk!: number;

  @Prop({ required: true })
  apkUrl!: string;

  @Prop({ required: true })
  apkSha256!: string;

  @Prop({ required: true })
  apkSize!: number;

  @Prop({ required: true })
  certificateSha256!: string;

  @Prop({ type: [String], required: true })
  downloadHosts!: string[];

  @Prop({ required: true })
  mandatory!: boolean;

  @Prop({ required: true })
  rolloutPercent!: number;

  @Prop({ required: true, default: '' })
  notes!: string;

  @Prop({ required: true, index: true })
  publishedAt!: Date;

  @Prop({ required: true })
  manifestBase64!: string;

  @Prop({ required: true })
  signatureBase64!: string;

  @Prop({ required: true })
  signatureAlgorithm!: string;

  @Prop({ required: true, default: false, index: true })
  revoked!: boolean;
}

export type AndroidAppReleaseDocument =
  HydratedDocument<AndroidAppReleaseEntity>;
export const AndroidAppReleaseSchema = SchemaFactory.createForClass(
  AndroidAppReleaseEntity,
);

AndroidAppReleaseSchema.index(
  { channel: 1, packageName: 1, versionCode: -1 },
  { unique: true, name: 'android_release_version' },
);
