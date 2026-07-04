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
  CompactCard,
  LevelBucket,
  PlatePlan,
  VersionBucket,
} from '../score-export.types';
import { FONT_FAMILY, VERSION_DISPLAY_NAME } from './score-export.constants';
import { createCanvas } from '@napi-rs/canvas';
import type { UserNetProfile } from '../../users/user.types';
import { loadAsset, loadDiffCards } from './score-export.assets';
import { drawCardGrid } from './score-export.card-renderer';
import { drawFooter, drawProfileHeader } from './score-export.profile-renderer';
import {
  drawPlateGrid,
  isPlateCompleted,
  PLATE_CARD_STEP,
  PLATE_COLUMNS,
} from './score-export.plate-renderer';
import {
  CARD_STEP_Y,
  COLUMNS,
  drawGradientBg,
  type LoadCoverImage,
  type LoadRemoteImage,
} from './score-export.render-utils';

// ─── B50 ───────────────────────────────────────────────────────────────

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
    profile?.rating !== null && profile?.rating !== undefined
      ? profile.rating
      : Math.round(payload.total);

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
      dxScore: null,
      dxScoreMax: null,
      dxStar: null,
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
