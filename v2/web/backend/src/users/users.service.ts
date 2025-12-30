import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { UserEntity } from './user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(UserEntity.name)
    private readonly userModel: Model<UserEntity>,
  ) {}

  async list() {
    const docs = await this.userModel.find().sort({ createdAt: -1 }).limit(200);
    return docs.map((d) => d.toObject());
  }

  async getById(id: string) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const doc = await this.userModel.findById(id);
    if (!doc) {
      throw new NotFoundException('User not found');
    }
    return doc.toObject();
  }

  async create(input: { friendCode: string }) {
    const created = await this.userModel.create({
      friendCode: input.friendCode,
    });
    return created.toObject();
  }

  async update(id: string, input: { friendCode: string }) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.userModel.findByIdAndUpdate(
      id,
      { friendCode: input.friendCode },
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return updated.toObject();
  }

  async remove(id: string) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const deleted = await this.userModel.findByIdAndDelete(id);
    if (!deleted) {
      throw new NotFoundException('User not found');
    }

    return { deleted: true };
  }
}
