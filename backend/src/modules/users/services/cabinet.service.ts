import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { SyncEntity } from '../../sync/schemas/sync.schema';
import type { SyncDocument, SyncScore } from '../../sync/schemas/sync.schema';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';
import { decodeQrImage } from '../../../common/qr-decode';

/**
 * Minimum number of (musicId,level) rows that must match between
 * the user's stored sync and the cabinet's GetUserRivalMusicApi response
 * for us to accept the QR-derived cabinetUserId as belonging to this user.
 *
 * If the user's stored sync has fewer than this many rows, we just require
 * "all of them match" (capped at the row count). This handles brand-new
 * accounts with very few plays without weakening the check for typical users.
 */
const MIN_MATCH_ROWS = 10;

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
   *   1. Make sure the user has at least one previous sync (we need scores
   *      to verify identity against).
   *   2. Ask sdgb-worker to scan the QR — returns cabinetUserId + the
   *      cabinet's view of that user's rival music.
   *   3. Compare against our stored scores by (musicId,level). When at least
   *      MIN_MATCH_ROWS rows match exactly on both achievement and
   *      deluxscoreMax, we accept the binding.
   */
  async bindByQr(
    friendCode: string,
    qrCode: string,
  ): Promise<
    | { ok: true; cabinetUserId: number }
    | { ok: false; reason: 'no-sync' | 'mismatch'; matchedRows: number }
  > {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .lean();
    const localScores: SyncScore[] = sync?.scores ?? [];
    if (!localScores.length) {
      return { ok: false, reason: 'no-sync', matchedRows: 0 };
    }

    const { cabinetUserId, music } = await this.sdgb.scanQr(
      { qrCode },
      { tag: `bind:${friendCode}`, timeoutMs: 120_000 },
    );

    // Effective threshold: usually MIN_MATCH_ROWS, but if the user has
    // synced fewer than that we just require all of them to match.
    const required = Math.min(MIN_MATCH_ROWS, localScores.length);
    const matchedRows = this.countMatchingRows(localScores, music, required);
    this.logger.log(
      `bindByQr fc=${friendCode} cabinetUserId=${cabinetUserId} matched=${matchedRows}/${required}`,
    );

    if (matchedRows < required) {
      return { ok: false, reason: 'mismatch', matchedRows };
    }
    return { ok: true, cabinetUserId };
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
    earlyExitAt: number = MIN_MATCH_ROWS,
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
