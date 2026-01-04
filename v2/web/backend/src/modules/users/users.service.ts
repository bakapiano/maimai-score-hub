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

  async findByFriendCode(friendCode: string) {
    const doc = await this.userModel.findOne({ friendCode });
    return doc ? doc.toObject() : null;
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

  async create(input: {
    friendCode: string;
    divingFishImportToken?: string | null;
    lxnsImportToken?: string | null;
  }) {
    const created = await this.userModel.create({
      friendCode: input.friendCode,
      divingFishImportToken: input.divingFishImportToken ?? null,
      lxnsImportToken: input.lxnsImportToken ?? null,
    });
    return created.toObject();
  }

  async update(
    id: string,
    input: {
      divingFishImportToken?: string | null;
      lxnsImportToken?: string | null;
    },
  ) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.userModel.findByIdAndUpdate(
      id,
      {
        divingFishImportToken: input.divingFishImportToken ?? null,
        lxnsImportToken: input.lxnsImportToken ?? null,
      },
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return updated.toObject();
  }
}
