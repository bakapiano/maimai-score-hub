import type { ChartEntry, PlatePlan } from '../score-export.types';
import {
  type CanvasImage,
  loadAsset,
  loadFcAsset,
  loadFsAsset,
  loadRankAsset,
} from './score-export.assets';
import type {
  CanvasContext,
  LoadCoverImage,
} from './score-export.render-utils';
import { getRankFromScore } from './score-export.render-utils';

export const PLATE_COLUMNS = 10;
export const PLATE_CARD_SIZE = 100;
export const PLATE_CARD_GAP = 15;
export const PLATE_CARD_STEP = PLATE_CARD_SIZE + PLATE_CARD_GAP;

const FC_STATUS_RANK: Record<string, number> = {
  fc: 0,
  'fc+': 1,
  fcp: 1,
  ap: 2,
  'ap+': 3,
  app: 3,
};

const FS_STATUS_RANK: Record<string, number> = {
  fs: 0,
  'fs+': 1,
  fsp: 1,
  fdx: 2,
  fsd: 2,
  'fdx+': 3,
  fdxp: 3,
  'fsd+': 3,
  fsdp: 3,
};

function statusRank(
  table: Record<string, number>,
  value: string | null | undefined,
): number {
  if (!value) {
    return -1;
  }
  return table[value.trim().toLowerCase()] ?? -1;
}

function hasFcAtLeast(
  value: string | null | undefined,
  target: 'fc' | 'fc+' | 'ap' | 'ap+',
) {
  return statusRank(FC_STATUS_RANK, value) >= FC_STATUS_RANK[target];
}

function hasFsAtLeast(
  value: string | null | undefined,
  target: 'fs' | 'fs+' | 'fdx' | 'fdx+',
) {
  return statusRank(FS_STATUS_RANK, value) >= FS_STATUS_RANK[target];
}

export function isPlateCompleted(entry: ChartEntry, plan: PlatePlan): boolean {
  if (!entry.score) {
    return false;
  }
  switch (plan) {
    case 'jiang': {
      const scoreText = entry.score.score ?? null;
      if (!scoreText) {
        return false;
      }
      const val = parseFloat(scoreText.replace('%', ''));
      return !isNaN(val) && val >= 100;
    }
    case 'ji':
      return hasFcAtLeast(entry.score.fc, 'fc');
    case 'shen':
      return hasFcAtLeast(entry.score.fc, 'ap');
    case 'wuwu':
      return hasFsAtLeast(entry.score.fs, 'fdx');
  }
}

export async function drawPlateGrid(
  ctx: CanvasContext,
  items: ChartEntry[],
  startX: number,
  startY: number,
  plan: PlatePlan,
  loadCoverImage: LoadCoverImage,
) {
  for (let idx = 0; idx < items.length; idx++) {
    const entry = items[idx];
    const row = Math.floor(idx / PLATE_COLUMNS);
    const col = idx % PLATE_COLUMNS;
    const x = startX + col * PLATE_CARD_STEP;
    const y = startY + row * PLATE_CARD_STEP;

    const image = await loadCoverImage(entry.music.id);
    await drawPlateCard(ctx, x, y, entry, image ?? null, plan);
  }
}

async function drawPlateCard(
  ctx: CanvasContext,
  x: number,
  y: number,
  entry: ChartEntry,
  image: CanvasImage | null,
  plan: PlatePlan,
) {
  const size = PLATE_CARD_SIZE;
  const completed = isPlateCompleted(entry, plan);

  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x, y, size, size);
  if (image) {
    ctx.drawImage(image, x, y, size, size);
  }

  if (!completed) {
    return;
  }

  const completeBg = await loadAsset('complete_bg_2.png');
  if (completeBg) {
    ctx.drawImage(completeBg, x, y, size, size);
  }

  const iconSize = 75;
  const iconX = x + (size - iconSize) / 2;
  const iconY = y + (size - iconSize) / 2 - 5;

  switch (plan) {
    case 'jiang': {
      const scoreText = entry.score?.score ?? null;
      const rank = getRankFromScore(scoreText);
      if (rank) {
        const rankImg = await loadRankAsset(rank);
        if (rankImg) {
          ctx.drawImage(
            rankImg,
            x + (size - 102) / 2,
            y + (size - 46) / 2,
            102,
            46,
          );
        }
      }
      break;
    }
    case 'ji':
    case 'shen': {
      const fc = entry.score?.fc;
      if (fc) {
        const fcImg = await loadFcAsset(fc);
        if (fcImg) {
          ctx.drawImage(fcImg, iconX, iconY, iconSize, iconSize);
        }
      }
      break;
    }
    case 'wuwu': {
      const fs = entry.score?.fs;
      if (fs) {
        const fsImg = await loadFsAsset(fs);
        if (fsImg) {
          ctx.drawImage(fsImg, iconX, iconY, iconSize, iconSize);
        }
      }
      break;
    }
  }
}
