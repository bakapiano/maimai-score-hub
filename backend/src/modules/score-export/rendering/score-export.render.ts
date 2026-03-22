/**
 * B50 / Level / Version image renderer.
 *
 * Design follows the maimaiDX HoshinoBot style:
 *  - Pre-made card background images per difficulty
 *  - Rank / FC / FS icon overlays from game assets
 *  - Gradient background when b50_bg.png is absent
 *  - 5-column card grid, info drawn with stroked text
 */

import type {
  ChartEntry,
  CompactCard,
  LevelBucket,
  VersionBucket,
} from '../score-export.types';
import { FONT_FAMILY, ID_COLORS, LEVEL_COLORS } from './score-export.constants';
import { createCanvas } from '@napi-rs/canvas';
import type { UserNetProfile } from '../../users/user.types';
import {
  type CanvasImage,
  loadAsset,
  loadDiffCards,
  loadFcAsset,
  loadFsAsset,
  loadRankAsset,
  loadTypeAsset,
} from './score-export.assets';

export type CanvasContext = ReturnType<
  ReturnType<typeof createCanvas>['getContext']
>;
export type LoadCoverImage = (musicId: string) => Promise<CanvasImage | null>;
export type LoadRemoteImage = (url: string) => Promise<CanvasImage | null>;

// ─── helpers ───────────────────────────────────────────────────────────

function parseScore(score: string | null) {
  if (!score || typeof score !== 'string') return null;
  const parsed = parseFloat(score.replace('%', ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function getRank(scoreVal: number) {
  if (scoreVal >= 100.5) return 'SSS+';
  if (scoreVal >= 100) return 'SSS';
  if (scoreVal >= 99.5) return 'SS+';
  if (scoreVal >= 99) return 'SS';
  if (scoreVal >= 98) return 'S+';
  if (scoreVal >= 97) return 'S';
  if (scoreVal >= 94) return 'AAA';
  if (scoreVal >= 90) return 'AA';
  if (scoreVal >= 80) return 'A';
  if (scoreVal >= 75) return 'BBB';
  if (scoreVal >= 70) return 'BB';
  if (scoreVal >= 60) return 'B';
  if (scoreVal >= 50) return 'C';
  return 'D';
}

function getRankFromScore(score: string | null) {
  const parsed = parseScore(score);
  return parsed !== null ? getRank(parsed) : null;
}

function truncateText(ctx: CanvasContext, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(`${t}...`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}...`;
}

function drawStrokedText(
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
function drawGradientBg(
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

// ─── B50 ───────────────────────────────────────────────────────────────

/** Card image size (264 × 109 native) with grid step (276 × 114, 12px h-gap, 5px v-gap). */
const CARD_IMG_W = 264;
const CARD_IMG_H = 109;
const CARD_STEP_X = 276;
const CARD_STEP_Y = 114;
const COLUMNS = 5;

/**
 * Find the DX rating bar image filename based on rating value.
 * Matches original maimaiDX _findRaPic logic.
 */
function findRaPic(rating: number): string {
  if (rating < 1000) return 'UI_CMN_DXRating_01.png';
  if (rating < 2000) return 'UI_CMN_DXRating_02.png';
  if (rating < 4000) return 'UI_CMN_DXRating_03.png';
  if (rating < 7000) return 'UI_CMN_DXRating_04.png';
  if (rating < 10000) return 'UI_CMN_DXRating_05.png';
  if (rating < 12000) return 'UI_CMN_DXRating_06.png';
  if (rating < 13000) return 'UI_CMN_DXRating_07.png';
  if (rating < 14000) return 'UI_CMN_DXRating_08.png';
  if (rating < 14500) return 'UI_CMN_DXRating_09.png';
  if (rating < 15000) return 'UI_CMN_DXRating_10.png';
  return 'UI_CMN_DXRating_11.png';
}

export async function renderBest50Image(
  payload: {
    total: number;
    newSum: number;
    oldSum: number;
    newCards: CompactCard[];
    oldCards: CompactCard[];
    profile: UserNetProfile | null;
  },
  loadCoverImage: LoadCoverImage,
  loadRemoteImage: LoadRemoteImage,
): Promise<Buffer> {
  // Pre-load shared assets
  const diffCards = await loadDiffCards();
  const bgImage = await loadAsset('b50_bg.png');
  const designBar = await loadAsset('design.png');

  const padding = 16;
  const width = 1400; // b50_bg.png native width

  // ── Layout: DX (B15) on top, SD (B35) below ──
  const firstStartY = 235;
  const dxRows = Math.ceil(payload.newCards.length / COLUMNS) || 1;
  const dxGridH = dxRows * CARD_STEP_Y;
  const sectionGap = 52;
  const sdStartY = firstStartY + dxGridH + sectionGap;
  const sdRows = Math.ceil(payload.oldCards.length / COLUMNS) || 1;
  const sdGridH = sdRows * CARD_STEP_Y;
  const footerH = 110; // space for design bar + credit
  const height = Math.max(1600, sdStartY + sdGridH + footerH);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ── Background ──
  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, width, height);
  } else {
    drawGradientBg(ctx, width, height);
  }

  const profile = payload.profile;
  const rating =
    profile?.rating != null ? profile.rating : Math.round(payload.total);

  // ── Header: plate shifted left (no logo) ──
  // Original plate at x=300 (logo occupied 14..263). Without logo, shift left by 286.
  const PX = 14; // plate X origin (was 300)

  // plate (姓名框) at (PX, 60), 800×130
  const plate = await loadAsset('UI_Plate_300501.png');
  if (plate) {
    ctx.drawImage(plate, PX, 60, 800, 130);
  }

  // default icon at (PX+5, 65), 120×120
  const defaultIcon = await loadAsset('UI_Icon_309503.png');
  if (defaultIcon) {
    ctx.drawImage(defaultIcon, PX + 5, 65, 120, 120);
  }

  // user avatar overlay at (PX+5, 65), 120×120
  if (profile?.avatarUrl) {
    const avatarImg = await loadRemoteImage(profile.avatarUrl);
    if (avatarImg) {
      ctx.drawImage(avatarImg, PX + 5, 65, 120, 120);
    }
  }

  // DX rating bar at (PX+135, 72), 186×35
  const dxRatingBar = await loadAsset(findRaPic(rating));
  if (dxRatingBar) {
    ctx.drawImage(dxRatingBar, PX + 135, 72, 186, 35);
  }

  // Rating digits at (PX+220 + 15*n, 80), each 17×20
  const ratingStr = String(rating).padStart(5, '0');
  for (let n = 0; n < ratingStr.length; n++) {
    const digitImg = await loadAsset(`UI_NUM_Drating_${ratingStr[n]}.png`);
    if (digitImg) {
      ctx.drawImage(digitImg, PX + 220 + 15 * n, 80, 17, 20);
    }
  }

  // Name.png (username background) at (PX+135, 115), native size
  const nameBg = await loadAsset('Name.png');
  if (nameBg) {
    ctx.drawImage(nameBg, PX + 135, 115);
  }

  // MatchLevel (段位) at (PX+325, 120), 80×32 — load from courseRankUrl
  if (profile?.courseRankUrl) {
    const matchImg = await loadRemoteImage(profile.courseRankUrl);
    if (matchImg) {
      ctx.drawImage(matchImg, PX + 325, 120, 80, 32);
    }
  }

  // ClassLevel (階級) at (PX+320, 60), 90×54 — load from classRankUrl or default
  if (profile?.classRankUrl) {
    const classImg = await loadRemoteImage(profile.classRankUrl);
    if (classImg) {
      ctx.drawImage(classImg, PX + 320, 60, 90, 54);
    }
  } else {
    const defaultClass = await loadAsset('UI_FBR_Class_00.png');
    if (defaultClass) {
      ctx.drawImage(defaultClass, PX + 320, 60, 90, 54);
    }
  }

  // Shougou (称号) rainbow bar at (PX+135, 160), 270×27
  const shougou = await loadAsset('UI_CMN_Shougou_Rainbow.png');
  if (shougou) {
    ctx.drawImage(shougou, PX + 135, 160, 270, 27);
  }

  // Username text at (PX+145, 135), font 25, anchor='lm' (left-middle)
  ctx.font = `25px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.fillText(profile?.username ?? '', PX + 145, 135);

  // Title text centered on the shougou bar at (PX+270, 173), font 13, anchor='mm'
  if (profile?.title) {
    ctx.font = `13px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillText(profile.title, PX + 270, 173);
  }

  // ── Section title: 现版本 Best 15 ──
  const sdRating = payload.oldSum.toFixed(0);
  const dxRating = payload.newSum.toFixed(0);
  ctx.font = `bold 20px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  // eslint-disable-next-line no-irregular-whitespace
  const dxTitle = `现版本 Best 15　Rating: ${dxRating}`;
  ctx.strokeText(dxTitle, padding + 8, firstStartY - 30);
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillText(dxTitle, padding + 8, firstStartY - 30);

  // ── DX Best 15 cards ──
  await drawCardGrid(
    ctx,
    payload.newCards,
    padding,
    firstStartY,
    diffCards,
    loadCoverImage,
  );

  // ── Section title: 旧版本 Best 35 ──
  ctx.font = `bold 20px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  // eslint-disable-next-line no-irregular-whitespace
  const sdTitle = `旧版本 Best 35　Rating: ${sdRating}`;
  ctx.strokeText(sdTitle, padding + 8, sdStartY - 30);
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillText(sdTitle, padding + 8, sdStartY - 30);

  // ── SD Best 35 cards ──
  await drawCardGrid(
    ctx,
    payload.oldCards,
    padding,
    sdStartY,
    diffCards,
    loadCoverImage,
  );

  // ── Footer ──
  const footerY = height - footerH;
  // design.png bar, centered, 800×72 (original resized)
  if (designBar) {
    ctx.drawImage(designBar, 300, footerY, 800, 72);
  }
  // Credit text at (700, footerY + 40), font 22, anchor='mm'
  // Original: text_color = (124, 129, 255), stroke=5 white
  ctx.font = `22px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  const creditText = 'Generated by MaiScoreHub';
  ctx.strokeText(creditText, 700, footerY + 40);
  ctx.fillStyle = 'rgba(124,129,255,1)';
  ctx.fillText(creditText, 700, footerY + 40);

  return canvas.toBuffer('image/png');
}

// ─── Card grid drawing ─────────────────────────────────────────────────

async function drawCardGrid(
  ctx: CanvasContext,
  cards: CompactCard[],
  startX: number,
  startY: number,
  diffCards: (CanvasImage | null)[],
  loadCoverImage: LoadCoverImage,
) {
  for (let idx = 0; idx < cards.length; idx++) {
    const row = Math.floor(idx / COLUMNS);
    const col = idx % COLUMNS;
    const x = startX + col * CARD_STEP_X;
    const y = startY + row * CARD_STEP_Y;
    await drawCard(ctx, x, y, cards[idx], diffCards, loadCoverImage);
  }
}

/**
 * Draw a single B50 score card, mimicking maimaiDX's layout:
 *
 *  ┌──────────────────────────────────────────┐
 *  │ [cover 75×75]  Title (truncated)         │  ← card bg = diff color
 *  │                Score: 100.1234%          │
 *  │  [type]  [rank]   ds → ra  [FC] [FS]    │
 *  │  [#id]                     [DXScore]     │
 *  └──────────────────────────────────────────┘
 */
async function drawCard(
  ctx: CanvasContext,
  x: number,
  y: number,
  card: CompactCard,
  diffCards: (CanvasImage | null)[],
  loadCoverImage: LoadCoverImage,
) {
  const diffBg = diffCards[card.chartIndex];
  const color = LEVEL_COLORS[card.chartIndex] ?? '#888';

  // Draw card background
  if (diffBg) {
    ctx.drawImage(diffBg, x, y, CARD_IMG_W, CARD_IMG_H);
  } else {
    // Fallback: draw colored rectangle with rounded feel
    ctx.fillStyle = color;
    ctx.fillRect(x, y, CARD_IMG_W, CARD_IMG_H);
    // Darker inner area
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + 2, y + 2, CARD_IMG_W - 4, CARD_IMG_H - 4);
  }

  // Cover image (75×75, with 12px offset from card edges)
  const coverSize = 75;
  const coverX = x + 12;
  const coverY = y + 12;

  const coverImage = await loadCoverImage(card.musicId);
  if (coverImage) {
    ctx.drawImage(coverImage, coverX, coverY, coverSize, coverSize);
  } else {
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(coverX, coverY, coverSize, coverSize);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold 10px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No Cover', coverX + coverSize / 2, coverY + coverSize / 2);
  }

  // Text color (white for most, purple for Re:Master)
  const textColor = card.chartIndex === 4 ? '#8a00e2' : '#ffffff';

  // ── Title (right of cover, top) ── original: (x+93, y+14)
  const textX = x + 93;
  const textMaxW = CARD_IMG_W - 93 - 8;

  ctx.font = `bold 14px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const title = truncateText(ctx, card.title, textMaxW);
  drawStrokedText(ctx, title, textX, y + 14, textColor, '#000', 2);

  // ── Score ── original: (x+93, y+38) font 30
  const scoreText = card.score ?? 'N/A';
  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  drawStrokedText(ctx, scoreText, textX, y + 38, textColor, '#000', 2);

  // ── ds → rating ── original: (x+93, y+65) font 15
  const ds = card.detailLevelText;
  const ra = typeof card.rating === 'number' ? Math.round(card.rating) : '-';
  ctx.font = `bold 15px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  drawStrokedText(ctx, `${ds} → ${ra}`, textX, y + 65, textColor, '#000', 2);

  // ── Type badge (SD/DX) ── original: (x+51, y+91) size (37, 14)
  const typeImg = await loadTypeAsset(card.type);
  if (typeImg) {
    ctx.drawImage(typeImg, x + 51, y + 91, 37, 14);
  } else {
    // Fallback: text badge
    if (card.type === 'dx') {
      ctx.fillStyle = '#f97316';
      ctx.fillRect(x + 51, y + 91, 30, 14);
      ctx.fillStyle = '#fff';
      ctx.font = `bold 10px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DX', x + 66, y + 98);
    }
  }

  // ── Rank icon ──
  const rank = getRankFromScore(card.score);
  if (rank) {
    const rankImg = await loadRankAsset(rank);
    if (rankImg) {
      ctx.drawImage(rankImg, x + 92, y + 78, 63, 28);
    } else {
      // Fallback: text rank
      ctx.font = `bold 16px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      drawStrokedText(ctx, rank, x + 98, y + 82, '#f5d142', '#000', 2);
    }
  }

  // ── FC icon ──
  if (card.fc) {
    const fcImg = await loadFcAsset(card.fc);
    if (fcImg) {
      ctx.drawImage(fcImg, x + 154, y + 77, 34, 34);
    } else {
      // Fallback: text
      ctx.font = `bold 10px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      drawStrokedText(
        ctx,
        card.fc.toUpperCase(),
        x + 171,
        y + 94,
        '#fff',
        '#000',
        2,
      );
    }
  }

  // ── FS icon ──
  if (card.fs) {
    const fsImg = await loadFsAsset(card.fs);
    if (fsImg) {
      ctx.drawImage(fsImg, x + 185, y + 77, 34, 34);
    } else {
      ctx.font = `bold 10px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      drawStrokedText(
        ctx,
        card.fs.toUpperCase(),
        x + 202,
        y + 94,
        '#fff',
        '#000',
        2,
      );
    }
  }

  // ── Song ID at bottom of cover ── original: (x+26, y+98) anchor 'mm'
  const idColor = ID_COLORS[card.chartIndex] ?? textColor;
  ctx.font = `bold 13px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawStrokedText(ctx, card.musicId, x + 26, y + 98, idColor);
}

// ─── Level scores image ────────────────────────────────────────────────

export async function renderLevelScoresImage(
  bucket: LevelBucket,
  levelKey: string,
  loadCoverImage: LoadCoverImage,
  loadIconImage: (icon: string) => Promise<CanvasImage | null>,
): Promise<Buffer> {
  const padding = 24;
  const cardSize = 72;
  const gap = 10;
  const columns = 10;
  const headerHeight = 32;
  const sectionGap = 28;

  let contentHeight = 0;
  bucket.details.forEach((detail) => {
    const rows = Math.max(1, Math.ceil(detail.items.length / columns));
    contentHeight +=
      headerHeight + rows * cardSize + (rows - 1) * gap + sectionGap;
  });

  const width = padding * 2 + columns * cardSize + gap * (columns - 1);
  const height = padding * 2 + 60 + contentHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  drawGradientBg(ctx, width, height);

  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  drawStrokedText(ctx, `等级 ${levelKey}`, padding, padding, '#fff', '#000', 3);

  let cursorY = padding + 48;

  for (const detail of bucket.details) {
    ctx.font = `bold 16px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    drawStrokedText(
      ctx,
      `定数 ${detail.detailKey}`,
      padding,
      cursorY,
      '#fff',
      '#000',
      2,
    );
    cursorY += headerHeight;

    await drawMinimalGrid(
      ctx,
      detail.items,
      padding,
      cursorY,
      columns,
      cardSize,
      gap,
      loadCoverImage,
      loadIconImage,
    );

    const rows = Math.max(1, Math.ceil(detail.items.length / columns));
    cursorY += rows * cardSize + (rows - 1) * gap + sectionGap;
  }

  return canvas.toBuffer('image/png');
}

// ─── Version scores image ──────────────────────────────────────────────

export async function renderVersionScoresImage(
  bucket: VersionBucket,
  versionKey: string,
  loadCoverImage: LoadCoverImage,
  loadIconImage: (icon: string) => Promise<CanvasImage | null>,
): Promise<Buffer> {
  const padding = 24;
  const cardSize = 72;
  const gap = 10;
  const columns = 10;
  const headerHeight = 32;
  const sectionGap = 28;

  let contentHeight = 0;
  bucket.levels.forEach((level) => {
    const rows = Math.max(1, Math.ceil(level.items.length / columns));
    contentHeight +=
      headerHeight + rows * cardSize + (rows - 1) * gap + sectionGap;
  });

  const width = padding * 2 + columns * cardSize + gap * (columns - 1);
  const height = padding * 2 + 60 + contentHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  drawGradientBg(ctx, width, height);

  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  drawStrokedText(
    ctx,
    `版本 ${versionKey}`,
    padding,
    padding,
    '#fff',
    '#000',
    3,
  );

  let cursorY = padding + 48;

  for (const level of bucket.levels) {
    ctx.font = `bold 16px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    drawStrokedText(
      ctx,
      `等级 ${level.levelKey}`,
      padding,
      cursorY,
      '#fff',
      '#000',
      2,
    );
    cursorY += headerHeight;

    await drawMinimalGrid(
      ctx,
      level.items,
      padding,
      cursorY,
      columns,
      cardSize,
      gap,
      loadCoverImage,
      loadIconImage,
    );

    const rows = Math.max(1, Math.ceil(level.items.length / columns));
    cursorY += rows * cardSize + (rows - 1) * gap + sectionGap;
  }

  return canvas.toBuffer('image/png');
}

// ─── Minimal grid (level / version views) ──────────────────────────────

async function drawMinimalGrid(
  ctx: CanvasContext,
  items: ChartEntry[],
  startX: number,
  startY: number,
  columns: number,
  cardSize: number,
  gap: number,
  loadCoverImage: LoadCoverImage,
  loadIconImage: (icon: string) => Promise<CanvasImage | null>,
) {
  for (let idx = 0; idx < items.length; idx++) {
    const entry = items[idx];
    const row = Math.floor(idx / columns);
    const col = idx % columns;
    const x = startX + col * (cardSize + gap);
    const y = startY + row * (cardSize + gap);

    const image = await loadCoverImage(entry.music.id);
    const fcIcon = entry.score?.fc ? await loadIconImage(entry.score.fc) : null;
    const fsIcon = entry.score?.fs ? await loadIconImage(entry.score.fs) : null;
    drawMinimalCard(ctx, x, y, cardSize, entry, image ?? null, fcIcon, fsIcon);
  }
}

function drawMinimalCard(
  ctx: CanvasContext,
  x: number,
  y: number,
  size: number,
  entry: ChartEntry,
  image: CanvasImage | null,
  fcIcon: CanvasImage | null,
  fsIcon: CanvasImage | null,
) {
  const color = LEVEL_COLORS[entry.chartIndex] ?? '#888';
  const borderWidth = 3;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);

  const coverSize = size - borderWidth * 2;
  const coverX = x + borderWidth;
  const coverY = y + borderWidth;
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(coverX, coverY, coverSize, coverSize);

  if (image) {
    ctx.drawImage(image, coverX, coverY, coverSize, coverSize);
  }

  // Dark overlay for readability
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(coverX, coverY, coverSize, coverSize);

  // Rank text in center
  const scoreText = entry.score?.score || entry.score?.dxScore || null;
  const rank = getRankFromScore(scoreText);
  if (rank) {
    ctx.font = `bold 18px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawStrokedText(
      ctx,
      rank,
      coverX + coverSize / 2,
      coverY + coverSize / 2 - 10,
      '#fff',
      '#000',
      3,
    );
  }

  // FC/FS icons at bottom
  const iconSize = 28;
  const iconY = coverY + coverSize - iconSize - 2;
  const iconGap = 2;

  const fcIconX = coverX + coverSize / 2 - iconSize - iconGap / 2;
  if (fcIcon) {
    ctx.drawImage(fcIcon, fcIconX, iconY, iconSize, iconSize);
  } else if (entry.score?.fc) {
    ctx.beginPath();
    ctx.arc(fcIconX + iconSize / 2, iconY + iconSize / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
  }

  const fsIconX = coverX + coverSize / 2 + iconGap / 2;
  if (fsIcon) {
    ctx.drawImage(fsIcon, fsIconX, iconY, iconSize, iconSize);
  } else if (entry.score?.fs) {
    ctx.beginPath();
    ctx.arc(fsIconX + iconSize / 2, iconY + iconSize / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
  }
}
