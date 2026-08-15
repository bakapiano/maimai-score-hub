import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { SyncEntity } from '../../sync/schemas/sync.schema';
import type { SyncDocument, SyncScore } from '../../sync/schemas/sync.schema';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';
import { decodeQrImage } from '../../../common/qr-decode';
import { CabinetIdentityMatcherService } from '../../auth/services/cabinet-identity-matcher.service';

/**
 * Accounts with fewer than four stored score rows use the name + B50 rating
 * identity resolver shared with QR login. Otherwise every stored row is
 * required, capped at ten matches for accounts with more scores.
 */
const MAX_SCORE_MATCH_ROWS = 10;
const MIN_SCORES_FOR_SCORE_MATCH = 4;

export type CabinetBindResult =
  | { ok: true; cabinetUserId: number }
  | { ok: false; pending: true; attemptId: string }
  | {
      ok: false;
      reason: 'mismatch';
      verification: 'scores';
      matchedRows: number;
      requiredRows: number;
    }
  | {
      ok: false;
      reason: 'mismatch';
      verification: 'profile';
      matchedRows: 0;
      requiredRows: null;
    };

/**
 * Convert deluxScore string (sometimes formatted like "1234" or "1,234")
 * to a number. Returns null when the value is missing/non-numeric.
 */
function parseDx(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cleaned = String(raw).replace(/,/g, '').trim();
  if (!cleaned) {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert prober achievement (e.g. "100.5210%") to the cabinet's int
 * representation (1005210). Returns null when missing.
 */
function parseAchievement(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cleaned = String(raw).replace(/%/g, '').trim();
  if (!cleaned) {
    return null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.round(n * 10000);
}

@Injectable()
export class CabinetService {
  private readonly logger = new Logger(CabinetService.name);

  constructor(
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly identityMatcher: CabinetIdentityMatcherService,
  ) {}

  /**
   * Decode a QR code from an image buffer (PNG/JPG/WebP/...). Returns the
   * embedded string, or null when no QR was found. Thin re-export so
   * existing callers keep working — implementation moved to
   * common/qr-decode.ts so AuthModule can reuse it.
   */
  async decodeQrImage(buf: Buffer): Promise<string | null> {
    return decodeQrImage(buf);
  }

  /**
   * Bind flow:
   *   1. Ask sdgb-worker to scan the QR — returns cabinetUserId + the
   *      cabinet's view of that user's rival music.
   *   2. With at least four stored scores, compare every row up to a maximum
   *      of ten exact matches.
   *   3. With fewer than four stored scores, resolve the friendCode using the
   *      same name + B50 rating flow as QR login.
   */
  async bindByQr(
    friendCode: string,
    qrCode: string,
    ownerUserId?: string,
  ): Promise<CabinetBindResult> {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .lean();
    const localScores: SyncScore[] = sync?.scores ?? [];

    const scan = await this.sdgb.scanQr(
      { qrCode },
      { tag: `bind:${friendCode}`, timeoutMs: 120_000 },
    );

    if (localScores.length < MIN_SCORES_FOR_SCORE_MATCH) {
      if (
        ownerUserId &&
        (await this.identityMatcher.isClaimIdentityEnabled())
      ) {
        const started = await this.identityMatcher.startClaimResolution(scan, {
          purpose: 'cabinet_binding',
          ownerUserId,
          expectedFriendCode: friendCode,
        });
        return { ok: false, pending: true, attemptId: started.attemptId };
      }
      const identity = await this.identityMatcher.match(scan, {
        tagPrefix: 'cabinet-bind',
        context: `Cabinet-bind fc=${friendCode}`,
        source: 'cabinet_binding',
      });
      this.logger.log(
        `bindByQr profile fc=${friendCode} resolvedFc=${identity.friendCode} cabinetUserId=${scan.cabinetUserId}`,
      );
      if (identity.friendCode !== friendCode) {
        return {
          ok: false,
          reason: 'mismatch',
          verification: 'profile',
          matchedRows: 0,
          requiredRows: null,
        };
      }
      return { ok: true, cabinetUserId: scan.cabinetUserId };
    }

    const requiredRows = Math.min(MAX_SCORE_MATCH_ROWS, localScores.length);
    const matchedRows = this.countMatchingRows(
      localScores,
      scan.music,
      requiredRows,
    );
    this.logger.log(
      `bindByQr scores fc=${friendCode} cabinetUserId=${scan.cabinetUserId} matched=${matchedRows}/${requiredRows}`,
    );

    if (matchedRows < requiredRows) {
      return {
        ok: false,
        reason: 'mismatch',
        verification: 'scores',
        matchedRows,
        requiredRows,
      };
    }
    return { ok: true, cabinetUserId: scan.cabinetUserId };
  }

  /**
   * Build a (cid → musicId-int) map so we can compare prober scores (whose
   * musicId is a string with letter prefixes for some categories) against
   * the cabinet's numeric musicId.
   *
   * The MusicEntity.id is the canonical string id used throughout the
   * prober codebase. The cabinet uses a numeric variant. For DX/standard
   * charts the numeric id is just `Number(music.id)`, so we filter to
   * those that parse as integers — the rest can never match.
   */
  private countMatchingRows(
    localScores: SyncScore[],
    cabinetMusic: SdgbWorkerMusicEntry[],
    earlyExitAt: number = MAX_SCORE_MATCH_ROWS,
  ): number {
    const cabinetMap = new Map<string, { ach: number; dx: number }>();
    for (const m of cabinetMusic) {
      for (const d of m.userRivalMusicDetailList ?? []) {
        cabinetMap.set(`${m.musicId}::${d.level}`, {
          ach: d.achievement,
          dx: d.deluxscoreMax,
        });
      }
    }

    let matched = 0;
    for (const s of localScores) {
      const numericMusicId = Number(s.musicId);
      if (!Number.isFinite(numericMusicId)) {
        continue;
      }
      // chartIndex follows the same 0..4 + 10 (utage) convention as the cabinet
      const cabinet = cabinetMap.get(`${numericMusicId}::${s.chartIndex}`);
      if (!cabinet) {
        continue;
      }

      const localAch = parseAchievement(s.score);
      const localDx = parseDx(s.dxScore);
      if (localAch === null || localDx === null) {
        continue;
      }

      if (localAch === cabinet.ach && localDx === cabinet.dx) {
        matched++;
        if (matched >= earlyExitAt) {
          // Early exit — we only need to prove we're at the threshold.
          return matched;
        }
      }
    }
    return matched;
  }
}
