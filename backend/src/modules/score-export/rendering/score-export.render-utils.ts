import type { createCanvas } from '@napi-rs/canvas';

import type { CanvasImage } from './score-export.assets';

export type CanvasContext = ReturnType<
  ReturnType<typeof createCanvas>['getContext']
>;
export type LoadCoverImage = (musicId: string) => Promise<CanvasImage | null>;
export type LoadRemoteImage = (url: string) => Promise<CanvasImage | null>;

export const CARD_IMG_W = 264;
export const CARD_IMG_H = 109;
export const CARD_STEP_X = 276;
export const CARD_STEP_Y = 114;
export const COLUMNS = 5;

export function parseScore(score: string | null) {
  if (!score || typeof score !== 'string') {
    return null;
  }
  const parsed = parseFloat(score.replace('%', ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function getRank(scoreVal: number) {
  if (scoreVal >= 100.5) {
    return 'SSS+';
  }
  if (scoreVal >= 100) {
    return 'SSS';
  }
  if (scoreVal >= 99.5) {
    return 'SS+';
  }
  if (scoreVal >= 99) {
    return 'SS';
  }
  if (scoreVal >= 98) {
    return 'S+';
  }
  if (scoreVal >= 97) {
    return 'S';
  }
  if (scoreVal >= 94) {
    return 'AAA';
  }
  if (scoreVal >= 90) {
    return 'AA';
  }
  if (scoreVal >= 80) {
    return 'A';
  }
  if (scoreVal >= 75) {
    return 'BBB';
  }
  if (scoreVal >= 70) {
    return 'BB';
  }
  if (scoreVal >= 60) {
    return 'B';
  }
  if (scoreVal >= 50) {
    return 'C';
  }
  return 'D';
}

export function getRankFromScore(score: string | null) {
  const parsed = parseScore(score);
  return parsed !== null ? getRank(parsed) : null;
}

export function truncateText(
  ctx: CanvasContext,
  text: string,
  maxWidth: number,
) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let t = text;
  while (t.length > 0 && ctx.measureText(`${t}...`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}...`;
}

export function drawStrokedText(
  ctx: CanvasContext,
  text: string,
  x: number,
  y: number,
  fill: string,
  stroke?: string,
  lineWidth?: number,
) {
  void stroke;
  void lineWidth;
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** Draw a tricolor vertical gradient (like maimaiDX's background). */
export function drawGradientBg(
  ctx: CanvasContext,
  w: number,
  h: number,
  c1 = [124, 129, 255],
  c2 = [193, 247, 225],
  c3 = [255, 255, 255],
) {
  const half = h / 2;
  for (let y = 0; y < h; y++) {
    let r: number, g: number, b: number;
    if (y < half) {
      const t = y / half;
      r = c1[0] + (c2[0] - c1[0]) * t;
      g = c1[1] + (c2[1] - c1[1]) * t;
      b = c1[2] + (c2[2] - c1[2]) * t;
    } else {
      const t = (y - half) / half;
      r = c2[0] + (c3[0] - c2[0]) * t;
      g = c2[1] + (c3[1] - c2[1]) * t;
      b = c2[2] + (c3[2] - c2[2]) * t;
    }
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(0, y, w, 1);
  }
}

/**
 * Find the DX rating bar image filename based on rating value.
 * Matches original maimaiDX _findRaPic logic.
 */
export function findRaPic(rating: number): string {
  if (rating < 1000) {
    return 'UI_CMN_DXRating_01.png';
  }
  if (rating < 2000) {
    return 'UI_CMN_DXRating_02.png';
  }
  if (rating < 4000) {
    return 'UI_CMN_DXRating_03.png';
  }
  if (rating < 7000) {
    return 'UI_CMN_DXRating_04.png';
  }
  if (rating < 10000) {
    return 'UI_CMN_DXRating_05.png';
  }
  if (rating < 12000) {
    return 'UI_CMN_DXRating_06.png';
  }
  if (rating < 13000) {
    return 'UI_CMN_DXRating_07.png';
  }
  if (rating < 14000) {
    return 'UI_CMN_DXRating_08.png';
  }
  if (rating < 14500) {
    return 'UI_CMN_DXRating_09.png';
  }
  if (rating < 15000) {
    return 'UI_CMN_DXRating_10.png';
  }
  return 'UI_CMN_DXRating_11.png';
}
