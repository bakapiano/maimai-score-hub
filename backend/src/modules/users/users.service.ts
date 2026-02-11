import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { UserEntity } from './user.schema';
import type { UserNetProfile } from './user.types';

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
    profile?: UserNetProfile | null;
  }) {
    const created = await this.userModel.create({
      friendCode: input.friendCode,
      divingFishImportToken: input.divingFishImportToken ?? null,
      lxnsImportToken: input.lxnsImportToken ?? null,
      profile: input.profile ?? null,
    });
    return created.toObject();
  }

  async update(
    id: string,
    input: {
      divingFishImportToken?: string | null;
      lxnsImportToken?: string | null;
      profile?: UserNetProfile | null;
      idleUpdateBotFriendCode?: string | null;
    },
  ) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException('User not found');
    }

    const updateDoc: Record<string, unknown> = {};
    if ('divingFishImportToken' in input) {
      updateDoc.divingFishImportToken = input.divingFishImportToken ?? null;
    }
    if ('lxnsImportToken' in input) {
      updateDoc.lxnsImportToken = input.lxnsImportToken ?? null;
    }
    if ('profile' in input) {
      updateDoc.profile = input.profile ?? null;
    }
    if ('idleUpdateBotFriendCode' in input) {
      updateDoc.idleUpdateBotFriendCode = input.idleUpdateBotFriendCode ?? null;
    }

    const updated = await this.userModel.findByIdAndUpdate(id, updateDoc, {
      new: true,
    });

    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return updated.toObject();
  }

  /**
   * 获取所有开启了闲时更新的用户
   */
  async getIdleUpdateUsers() {
    const users = await this.userModel
      .find({ idleUpdateBotFriendCode: { $ne: null } })
      .lean();
    return users;
  }

  /**
   * 统计某个 bot 有多少用户正在使用它做闲时更新
   */
  async countIdleUpdateByBot(botFriendCode: string): Promise<number> {
    return this.userModel.countDocuments({
      idleUpdateBotFriendCode: botFriendCode,
    });
  }
}
