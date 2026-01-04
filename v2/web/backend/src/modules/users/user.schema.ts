import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true })
export class UserEntity {
  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ type: String, default: null })
  divingFishImportToken!: string | null;

  @Prop({ type: String, default: null })
  lxnsImportToken!: string | null;
}

export type UserDocument = HydratedDocument<UserEntity>;
export const UserSchema = SchemaFactory.createForClass(UserEntity);
