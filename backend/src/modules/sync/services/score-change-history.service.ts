import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type {
  ScoreChange,
  ScoreChangeHistoryQuery,
  ScoreChangeHistoryResponse,
} from '@maimai-score-hub/shared';
import { Types, type Model, type QueryFilter } from 'mongoose';

import {
  ScoreChangeEntity,
  type ScoreChangeDocument,
} from '../schemas/score-change.schema';

type ScoreChangeRow = ScoreChangeEntity & { _id: Types.ObjectId };
type HistoryCursor = { observedAt: Date; objectId: Types.ObjectId };

@Injectable()
export class ScoreChangeHistoryService {
  constructor(
    @InjectModel(ScoreChangeEntity.name)
    private readonly scoreChanges: Model<ScoreChangeDocument>,
  ) {}

  async listForUser(
    friendCode: string,
    query: ScoreChangeHistoryQuery,
  ): Promise<ScoreChangeHistoryResponse> {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const filter: QueryFilter<ScoreChangeDocument> = {
      friendCode,
      musicId: query.musicId,
      chartIndex: query.chartIndex,
      type: query.type,
    };

    if (cursor) {
      filter.$or = [
        { observedAt: { $lt: cursor.observedAt } },
        {
          observedAt: cursor.observedAt,
          _id: { $lt: cursor.objectId },
        },
      ];
    }

    const rows = await this.scoreChanges
      .find(filter)
      .sort({ observedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<ScoreChangeRow[]>();
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => this.toResponse(row)),
      nextCursor: hasMore && last ? this.encodeCursor(last) : null,
    };
  }

  private toResponse(row: ScoreChangeRow): ScoreChange {
    return {
      id: row.id,
      observedAt: new Date(row.observedAt).toISOString(),
      sourceType: row.sourceType,
      beforeScoreVersion: row.beforeScoreVersion ?? null,
      afterScoreVersion: row.afterScoreVersion,
      musicId: row.musicId,
      chartIndex: row.chartIndex,
      type: row.type,
      before: row.before ?? {},
      after: row.after ?? {},
      changedFields: row.changedFields ?? [],
      achievementDelta: row.achievementDelta ?? null,
      dxScoreDelta: row.dxScoreDelta ?? null,
      ratingDelta: row.ratingDelta ?? null,
      fcRankDelta: row.fcRankDelta ?? null,
      fsRankDelta: row.fsRankDelta ?? null,
    };
  }

  private encodeCursor(row: ScoreChangeRow): string {
    return Buffer.from(
      JSON.stringify({
        observedAt: new Date(row.observedAt).toISOString(),
        objectId: row._id.toHexString(),
      }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(raw: string): HistoryCursor {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw this.invalidCursor();
    }

    if (
      !value ||
      typeof value !== 'object' ||
      !('observedAt' in value) ||
      !('objectId' in value) ||
      typeof value.observedAt !== 'string' ||
      typeof value.objectId !== 'string' ||
      !Types.ObjectId.isValid(value.objectId)
    ) {
      throw this.invalidCursor();
    }

    const observedAt = new Date(value.observedAt);
    if (!Number.isFinite(observedAt.getTime())) {
      throw this.invalidCursor();
    }
    return {
      observedAt,
      objectId: new Types.ObjectId(value.objectId),
    };
  }

  private invalidCursor(): BadRequestException {
    return new BadRequestException({
      code: 'INVALID_SCORE_CHANGE_CURSOR',
      message: 'Invalid score change history cursor',
    });
  }
}
