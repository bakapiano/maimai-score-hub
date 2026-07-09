/**
 * Asset loader for B50 image rendering.
 *
 * Expected directory layout under `assets/mai/pic/`:
 *     b50_bg.png              – full background (1400 × ~1600)
 *     b50_score_basic.png     – card bg for Basic
 *     b50_score_advanced.png  – card bg for Advanced
 *     b50_score_expert.png    – card bg for Expert
 *     b50_score_master.png    – card bg for Master
 *     b50_score_remaster.png  – card bg for Re:Master
 *     UI_TTR_Rank_*.png       – rank icons
 *     UI_MSS_MBase_Icon_*.png – FC/FS badge icons
 *     SD.png / DX.png         – chart type badges
 *     logo.png                – maimai logo
 *     design.png              – footer design bar
 *
 * If assets are missing the renderer falls back to code-drawn equivalents.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadImage } from '@napi-rs/canvas';

export type CanvasImage = Awaited<ReturnType<typeof loadImage>>;

const ASSETS_BASE = join(process.cwd(), 'assets', 'mai', 'pic');

const cache = new Map<string, CanvasImage | null>();

export async function loadAsset(filename: string): Promise<CanvasImage | null> {
  if (cache.has(filename)) {
    return cache.get(filename)!;
  }
  const fullPath = join(ASSETS_BASE, filename);
  if (!existsSync(fullPath)) {
    cache.set(filename, null);
    return null;
  }
  try {
    const img = await loadImage(fullPath);
    cache.set(filename, img);
    return img;
  } catch {
    cache.set(filename, null);
    return null;
  }
}

export function hasAssetDir(): boolean {
  return existsSync(ASSETS_BASE);
}

const DIFF_FILENAMES = [
  'b50_score_basic.png',
  'b50_score_advanced.png',
  'b50_score_expert.png',
  'b50_score_master.png',
  'b50_score_remaster.png',
];

export async function loadDiffCards(): Promise<(CanvasImage | null)[]> {
  return Promise.all(DIFF_FILENAMES.map(loadAsset));
}

const FC_ASSET: Record<string, string> = {
  fc: 'UI_MSS_MBase_Icon_FC.png',
  'fc+': 'UI_MSS_MBase_Icon_FCp.png',
  fcp: 'UI_MSS_MBase_Icon_FCp.png',
  ap: 'UI_MSS_MBase_Icon_AP.png',
  'ap+': 'UI_MSS_MBase_Icon_APp.png',
  app: 'UI_MSS_MBase_Icon_APp.png',
};

const FS_ASSET: Record<string, string> = {
  fs: 'UI_MSS_MBase_Icon_FS.png',
  'fs+': 'UI_MSS_MBase_Icon_FSp.png',
  fsp: 'UI_MSS_MBase_Icon_FSp.png',
  fdx: 'UI_MSS_MBase_Icon_FSD.png',
  'fdx+': 'UI_MSS_MBase_Icon_FSDp.png',
  fdxp: 'UI_MSS_MBase_Icon_FSDp.png',
  fsd: 'UI_MSS_MBase_Icon_FSD.png',
  'fsd+': 'UI_MSS_MBase_Icon_FSDp.png',
  fsdp: 'UI_MSS_MBase_Icon_FSDp.png',
};

export async function loadFcAsset(key: string): Promise<CanvasImage | null> {
  const normalized = key.toLowerCase();
  return FC_ASSET[normalized] ? loadAsset(FC_ASSET[normalized]) : null;
}

export async function loadFsAsset(key: string): Promise<CanvasImage | null> {
  const normalized = key.toLowerCase();
  return FS_ASSET[normalized] ? loadAsset(FS_ASSET[normalized]) : null;
}

const RANK_FILE: Record<string, string> = {
  'SSS+': 'UI_TTR_Rank_SSSp.png',
  SSS: 'UI_TTR_Rank_SSS.png',
  'SS+': 'UI_TTR_Rank_SSp.png',
  SS: 'UI_TTR_Rank_SS.png',
  'S+': 'UI_TTR_Rank_Sp.png',
  S: 'UI_TTR_Rank_S.png',
  AAA: 'UI_TTR_Rank_AAA.png',
  AA: 'UI_TTR_Rank_AA.png',
  A: 'UI_TTR_Rank_A.png',
  BBB: 'UI_TTR_Rank_BBB.png',
  BB: 'UI_TTR_Rank_BB.png',
  B: 'UI_TTR_Rank_B.png',
  C: 'UI_TTR_Rank_C.png',
  D: 'UI_TTR_Rank_D.png',
};

export async function loadRankAsset(rank: string): Promise<CanvasImage | null> {
  return RANK_FILE[rank] ? loadAsset(RANK_FILE[rank]) : null;
}

export async function loadTypeAsset(type: string): Promise<CanvasImage | null> {
  return loadAsset(type === 'dx' ? 'DX.png' : 'SD.png');
}

export async function loadDxScoreIconAsset(
  stars: number,
): Promise<CanvasImage | null> {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return null;
  }
  return loadAsset(`UI_GAM_Gauge_DXScoreIcon_0${stars}.png`);
}
