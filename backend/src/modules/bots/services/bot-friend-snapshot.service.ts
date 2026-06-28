import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { BotStatusEntity } from '../schemas/bot-status.schema';

export interface BotFriendRow {
  friendCode: string;
  userName: string | null;
  rating: number | null;
}

@Injectable()
export class BotFriendSnapshotService {
  constructor(
    @InjectModel(BotStatusEntity.name)
    private readonly botStatusModel: Model<BotStatusEntity>,
  ) {}

  /** Full-overwrite per bot. Workers call this when they have a friend list. */
  async report(
    botFriendCode: string,
    friends: BotFriendRow[],
    updatedAt = new Date(),
  ): Promise<void> {
    await this.botStatusModel.updateOne(
      { friendCode: botFriendCode },
      {
        $set: {
          friends,
          friendCount: friends.length,
          friendsUpdatedAt: updatedAt,
        },
        $setOnInsert: {
          friendCode: botFriendCode,
          available: true,
          lastReportedAt: updatedAt,
        },
      },
      { upsert: true },
    );
  }

  async get(botFriendCode: string): Promise<{
    botFriendCode: string;
    friends: BotFriendRow[];
    updatedAt: Date | null;
  } | null> {
    const doc = await this.botStatusModel
      .findOne({ friendCode: botFriendCode })
      .select({ friendCode: 1, friends: 1, friendsUpdatedAt: 1 })
      .lean();
    if (!doc) {
      return null;
    }
    return {
      botFriendCode: doc.friendCode,
      friends: doc.friends ?? [],
      updatedAt: doc.friendsUpdatedAt ?? null,
    };
  }

  async hasFriend(botFriendCode: string, friendCode: string): Promise<boolean> {
    const doc = await this.botStatusModel
      .findOne({ friendCode: botFriendCode, 'friends.friendCode': friendCode })
      .select({ _id: 1 })
      .lean();
    return !!doc;
  }

  async findBotHavingFriend(
    friendCode: string,
    botFriendCodes: string[],
  ): Promise<string | null> {
    if (botFriendCodes.length === 0) {
      return null;
    }

    const docs = await this.botStatusModel
      .find({
        friendCode: { $in: botFriendCodes },
        'friends.friendCode': friendCode,
      })
      .select({ friendCode: 1, _id: 0 })
      .lean();
    const hits = new Set(docs.map((d) => d.friendCode));
    return (
      botFriendCodes.find((botFriendCode) => hits.has(botFriendCode)) ?? null
    );
  }

  /**
   * Look up a friend by (userName, rating) inside one bot's snapshot.
   * Used by QR-login to translate (cabinet displayName, computed b50)
   * back to friendCode.
   *
   * - 'not_found': no row matches both fields exactly
   * - 'ambiguous': multiple rows match (rare; same-name + same-rating)
   * - { friendCode }: unique match
   */
  async findFriendByNameRating(
    botFriendCode: string,
    userName: string,
    rating: number,
  ): Promise<
    | { kind: 'found'; friendCode: string }
    | { kind: 'not_found' }
    | { kind: 'ambiguous'; matches: number }
  > {
    const snap = await this.get(botFriendCode);
    if (!snap) {
      return { kind: 'not_found' };
    }
    const matches = snap.friends.filter(
      (f) => f.userName === userName && f.rating === rating,
    );
    if (matches.length === 0) {
      return { kind: 'not_found' };
    }
    if (matches.length > 1) {
      return { kind: 'ambiguous', matches: matches.length };
    }
    return { kind: 'found', friendCode: matches[0].friendCode };
  }
}
