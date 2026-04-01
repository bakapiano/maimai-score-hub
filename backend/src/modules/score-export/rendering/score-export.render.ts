/**
 * B50 / Level / Version image renderer.
 *
 * Design and layout based on the maimaiDX HoshinoBot plugin by Yuri-YuzuChaN:
 * https://github.com/Yuri-YuzuChaN/maimaiDX
 *
 *  - Pre-made card background images per difficulty
 *  - Rank / FC / FS icon overlays from game assets
 *  - Gradient background when b50_bg.png is absent
 *  - 5-column card grid, info drawn with stroked text
 */

import type {
  ChartEntry,
  CompactCard,
  LevelBucket,
  PlatePlan,
  VersionBucket,
} from '../score-export.types';
import {
  FONT_FAMILY,
  ID_COLORS,
  LEVEL_COLORS,
  VERSION_DISPLAY_NAME,
} from './score-export.constants';
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

  await drawProfileHeader(ctx, profile, rating, loadRemoteImage);

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
  await drawFooter(ctx, width, footerY);

  return canvas.toBuffer('image/png');
}

// ─── Reusable header / footer ──────────────────────────────────────────

/**
 * Draw the profile header (plate, avatar, rating, name, title).
 * Draws at a fixed position (PX=14, starting Y=60).
 * Returns the Y position after the header (~200).
 */
async function drawProfileHeader(
  ctx: CanvasContext,
  profile: UserNetProfile | null,
  rating: number,
  loadRemoteImage: LoadRemoteImage,
): Promise<number> {
  const PX = 14; // plate X origin

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

  return 200; // Y position after header
}

/**
 * Draw the footer (design bar + credit text).
 */
async function drawFooter(
  ctx: CanvasContext,
  width: number,
  footerY: number,
): Promise<void> {
  const designBar = await loadAsset('design.png');
  if (designBar) {
    ctx.drawImage(designBar, 300, footerY, 800, 72);
  }
  ctx.font = `22px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  const creditText = 'Generated by MaiScoreHub';
  ctx.strokeText(creditText, width / 2, footerY + 40);
  ctx.fillStyle = 'rgba(124,129,255,1)';
  ctx.fillText(creditText, width / 2, footerY + 40);
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
  profile: UserNetProfile | null,
  rating: number,
  loadCoverImage: LoadCoverImage,
  loadRemoteImage: LoadRemoteImage,
): Promise<Buffer> {
  const diffCards = await loadDiffCards();
  const bgImage = await loadAsset('b50_bg.png');

  const padding = 16;
  const width = 1400; // same as B50
  const sectionGap = 52;
  const firstStartY = 235;

  // Calculate total height from all detail sections
  let contentHeight = 0;
  for (const detail of bucket.details) {
    const rows = Math.max(1, Math.ceil(detail.items.length / COLUMNS));
    contentHeight += sectionGap + rows * CARD_STEP_Y;
  }

  const footerH = 110;
  const height = Math.max(800, firstStartY + contentHeight + footerH);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ── Background ──
  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, width, height);
  } else {
    drawGradientBg(ctx, width, height);
  }

  // ── Profile header ──
  await drawProfileHeader(ctx, profile, rating, loadRemoteImage);

  // ── Detail sections ──
  let cursorY = firstStartY;

  for (const detail of bucket.details) {
    // Section title: "定数 13.0 (25 首)"
    const count = detail.items.length;
    const sectionTitle = `定数 ${detail.detailKey} (${count} 首)`;
    ctx.font = `bold 20px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.strokeText(sectionTitle, padding + 8, cursorY - 30);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillText(sectionTitle, padding + 8, cursorY - 30);

    // Convert ChartEntry[] to CompactCard[] for drawCardGrid
    const cards: CompactCard[] = detail.items.map((entry) => ({
      musicId: entry.music.id,
      chartIndex: entry.chartIndex,
      type: entry.music.type ?? 'standard',
      score: entry.score?.score ?? null,
      rating: entry.score?.rating ?? null,
      fc: entry.score?.fc ?? null,
      fs: entry.score?.fs ?? null,
      title: entry.music.title ?? 'Unknown',
      detailLevelText:
        typeof entry.chart?.detailLevel === 'number'
          ? entry.chart.detailLevel.toFixed(1)
          : (entry.chart?.level ?? '?'),
    }));

    await drawCardGrid(ctx, cards, padding, cursorY, diffCards, loadCoverImage);

    const rows = Math.max(1, Math.ceil(cards.length / COLUMNS));
    cursorY += rows * CARD_STEP_Y + sectionGap;
  }

  // ── Footer ──
  const footerY = height - footerH;
  await drawFooter(ctx, width, footerY);

  return canvas.toBuffer('image/png');
}

// ─── Version scores image ──────────────────────────────────────────────

const PLATE_COLUMNS = 10;
const PLATE_CARD_SIZE = 100;
const PLATE_CARD_GAP = 15;
const PLATE_CARD_STEP = PLATE_CARD_SIZE + PLATE_CARD_GAP;

export async function renderVersionScoresImage(
  bucket: VersionBucket,
  versionKey: string,
  profile: UserNetProfile | null,
  rating: number,
  plan: PlatePlan,
  loadCoverImage: LoadCoverImage,
  loadRemoteImage: LoadRemoteImage,
): Promise<Buffer> {
  const bgImage = await loadAsset('b50_bg.png');
  const padding = 50;
  const width = 1400;
  const sectionGap = 40;
  const firstStartY = 235;

  // Calculate total height
  let contentHeight = 0;
  for (const level of bucket.levels) {
    const rows = Math.max(1, Math.ceil(level.items.length / PLATE_COLUMNS));
    contentHeight += sectionGap + rows * PLATE_CARD_STEP;
  }

  const footerH = 110;
  const height = Math.max(800, firstStartY + contentHeight + footerH);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, width, height);
  } else {
    drawGradientBg(ctx, width, height);
  }

  // ── Profile header ──
  await drawProfileHeader(ctx, profile, rating, loadRemoteImage);

  // ── Version title (top right) ──
  const displayName = VERSION_DISPLAY_NAME[versionKey] ?? versionKey;
  const planLabel =
    plan === 'jiang'
      ? '将'
      : plan === 'ji'
        ? '极'
        : plan === 'shen'
          ? '神'
          : '舞舞';
  ctx.font = `bold 20px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  const versionTitle = `${displayName} ${planLabel}牌`;
  ctx.strokeText(versionTitle, width - padding - 8, 60);
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillText(versionTitle, width - padding - 8, 60);

  // ── Level sections ──
  let cursorY = firstStartY;

  for (const level of bucket.levels) {
    const count = level.items.length;
    const completed = level.items.filter((e) =>
      isPlateCompleted(e, plan),
    ).length;
    const sectionTitle = `${level.levelKey} (${completed}/${count})`;

    ctx.font = `bold 20px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.strokeText(sectionTitle, padding + 8, cursorY - 30);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillText(sectionTitle, padding + 8, cursorY - 30);

    await drawPlateGrid(
      ctx,
      level.items,
      padding,
      cursorY,
      plan,
      loadCoverImage,
    );

    const rows = Math.max(1, Math.ceil(level.items.length / PLATE_COLUMNS));
    cursorY += rows * PLATE_CARD_STEP + sectionGap;
  }

  // ── Footer ──
  const footerY = height - footerH;
  await drawFooter(ctx, width, footerY);

  return canvas.toBuffer('image/png');
}

// ─── Plate helpers ─────────────────────────────────────────────────────

/**
 * Check if a chart entry is "completed" according to the given plate plan.
 * - jiang (将): score >= 100%
 * - ji (极): has FC (fc, fcp, ap, app)
 * - wuwu (舞舞): has FS (fs, fsp, fsd, fsdp)
 */
function isPlateCompleted(entry: ChartEntry, plan: PlatePlan): boolean {
  if (!entry.score) return false;
  switch (plan) {
    case 'jiang': {
      const scoreText = entry.score.score ?? null;
      if (!scoreText) return false;
      const val = parseFloat(scoreText.replace('%', ''));
      return !isNaN(val) && val >= 100;
    }
    case 'ji':
      return !!entry.score.fc;
    case 'shen':
      return entry.score.fc === 'ap' || entry.score.fc === 'app';
    case 'wuwu':
      return entry.score.fs === 'fsd' || entry.score.fs === 'fsdp';
  }
}

// ─── Plate grid (version view) ─────────────────────────────────────────

async function drawPlateGrid(
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

  // Cover image (no border, like reference project)
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x, y, size, size);
  if (image) {
    ctx.drawImage(image, x, y, size, size);
  }

  // Only completed entries get an overlay + icon (matching reference project behavior)
  if (!completed) return;

  // complete_bg overlay
  const completeBg = await loadAsset('complete_bg_2.png');
  if (completeBg) {
    ctx.drawImage(completeBg, x, y, size, size);
  }

  // Plan-specific icon centered on the cover
  const iconSize = 75;
  const iconX = x + (size - iconSize) / 2;
  const iconY = y + (size - iconSize) / 2 - 5;

  switch (plan) {
    case 'jiang': {
      // 将牌: show Rank icon
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
      // 极牌/神牌: show FC/AP icon
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
      // 舞舞牌: show FS icon
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
