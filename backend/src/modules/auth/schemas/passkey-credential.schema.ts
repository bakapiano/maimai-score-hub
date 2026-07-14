import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  Schema as MongooseSchema,
  Types,
  type HydratedDocument,
} from 'mongoose';

import { UserEntity } from '../../users/schemas/user.schema';

export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

@Schema({ timestamps: true, collection: 'passkey_credentials' })
export class PasskeyCredentialEntity {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: UserEntity.name,
    required: true,
    index: true,
  })
  userId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  credentialId!: string;

  @Prop({ type: Buffer, required: true, select: false })
  publicKey!: Buffer;

  @Prop({ type: Number, required: true, default: 0 })
  counter!: number;

  @Prop({ type: [String], default: [] })
  transports!: string[];

  @Prop({
    type: String,
    enum: ['singleDevice', 'multiDevice'],
    required: true,
  })
  deviceType!: PasskeyDeviceType;

  @Prop({ type: Boolean, required: true, default: false })
  backedUp!: boolean;

  @Prop({ type: String, required: true, trim: true, maxlength: 50 })
  name!: string;

  @Prop({ type: Date, default: null })
  lastUsedAt!: Date | null;

  createdAt!: Date;

  updatedAt!: Date;
}

export type PasskeyCredentialDocument =
  HydratedDocument<PasskeyCredentialEntity>;
export const PasskeyCredentialSchema = SchemaFactory.createForClass(
  PasskeyCredentialEntity,
);

PasskeyCredentialSchema.index(
  { userId: 1, createdAt: -1 },
  { name: 'passkey_user_created' },
);
