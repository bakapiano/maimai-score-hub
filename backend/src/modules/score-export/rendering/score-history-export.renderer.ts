import { createCanvas } from '@napi-rs/canvas';
import type { UserNetProfile } from '../../users/user.types';
import type { HistoryExportCard } from '../score-export.types';
import {
  loadAsset,
  loadDxScoreIconAsset,
  loadFcAsset,
  loadFsAsset,
  loadRankAsset,
  loadTypeAsset,
} from './score-export.assets';
import { FONT_FAMILY, ID_COLORS, LEVEL_COLORS } from './score-export.constants';
import { drawFooter, drawProfileHeader } from './score-export.profile-renderer';
import {
  drawGradientBg,
  getRankFromScore,
  truncateText,
  type CanvasContext,
  type LoadCoverImage,
  type LoadRemoteImage,
} from './score-export.render-utils';

const WIDTH = 1520;
const OUTPUT_SCALE = 2;
const COLUMNS = 4;
const CARD_WIDTH = 360;
const CARD_HEIGHT = 126;
const CARD_STEP_X = 372;
const CARD_STEP_Y = 136;
const TOP_HEIGHT = 94;

type Payload = {
  date: string;
  dayStartHour: number;
  timeZone: string;
  cards: HistoryExportCard[];
  profile: UserNetProfile | null;
};

export async function renderScoreHistoryImage(
  payload: Payload,
  loadCoverImage: LoadCoverImage,
  loadRemoteImage: LoadRemoteImage,
): Promise<Buffer> {
  const background = await loadAsset('b50_bg.png');
  const padding = 16;
  const startY = 235;
  const rows = Math.max(1, Math.ceil(payload.cards.length / COLUMNS));
  const footerHeight = 110;
  const height = Math.max(620, startY + rows * CARD_STEP_Y + footerHeight);
  // Keep the same logical four-column layout while exporting at retina
  // density. Rank assets otherwise end up only a few dozen physical pixels
  // wide and look blurred when the downloaded image is viewed or shared.
  const canvas = createCanvas(WIDTH * OUTPUT_SCALE, height * OUTPUT_SCALE);
  const ctx = canvas.getContext('2d');
  const transform = ctx as unknown as {
    scale: (scaleX: number, scaleY: number) => void;
  };
  transform.scale(OUTPUT_SCALE, OUTPUT_SCALE);
  const smoothing = ctx as unknown as {
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: 'low' | 'medium' | 'high';
  };
  smoothing.imageSmoothingEnabled = true;
  smoothing.imageSmoothingQuality = 'high';

  if (background) {
    ctx.drawImage(background, 0, 0, WIDTH, height);
  } else {
    drawGradientBg(ctx, WIDTH, height);
  }
  await drawProfileHeader(
    ctx,
    payload.profile,
    payload.profile?.rating ?? 0,
    loadRemoteImage,
  );
  drawSectionTitle(
    ctx,
    `${payload.date} 成绩历史 · ${String(payload.dayStartHour).padStart(2, '0')}:00 分界 · ${payload.cards.length} 首`,
    padding + 8,
    startY - 32,
  );

  for (let index = 0; index < payload.cards.length; index += 1) {
    const x = padding + (index % COLUMNS) * CARD_STEP_X;
    const y = startY + Math.floor(index / COLUMNS) * CARD_STEP_Y;
    await drawHistoryCard(
      ctx,
      payload.cards[index],
      x,
      y,
      payload.timeZone,
      loadCoverImage,
    );
  }
  await drawFooter(ctx, WIDTH, height - footerHeight);
  return canvas.toBuffer('image/png');
}

function drawSectionTitle(
  ctx: CanvasContext,
  text: string,
  x: number,
  y: number,
) {
  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  drawOutlinedText(ctx, text, x, y, '#20242a', '#fff', 4);
}

// Card rendering is kept linear to make asset positions easy to audit.

async function drawHistoryCard(
  ctx: CanvasContext,
  card: HistoryExportCard,
  x: number,
  y: number,
  timeZone: string,
  loadCoverImage: LoadCoverImage,
) {
  const levelColor = LEVEL_COLORS[card.chartIndex] ?? '#888';
  ctx.fillStyle = levelColor;
  ctx.fillRect(x, y, CARD_WIDTH, TOP_HEIGHT);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y + TOP_HEIGHT, CARD_WIDTH, CARD_HEIGHT - TOP_HEIGHT);
  drawRectOutline(ctx, x, y, CARD_WIDTH, CARD_HEIGHT, 'rgba(0,0,0,0.24)');

  const cover = await loadCoverImage(card.musicId);
  if (cover) {
    ctx.drawImage(cover, x + 10, y + 10, 70, 70);
  } else {
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(x + 10, y + 10, 70, 70);
  }

  const textX = x + 90;
  const textWidth = CARD_WIDTH - 98;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 14px ${FONT_FAMILY}`;
  drawOutlinedText(
    ctx,
    truncateText(ctx, card.title, textWidth),
    textX,
    y + 14,
    '#fff',
  );
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(textX, y + 29, x + CARD_WIDTH - 8 - textX, 1);

  ctx.font = `bold 16px ${FONT_FAMILY}`;
  const achievement = formatAchievement(card.after.score);
  drawOutlinedText(ctx, achievement, textX, y + 47, '#fff');
  let achievementCursor = textX + ctx.measureText(achievement).width;
  if (isNonZero(card.achievementDelta, 0.00005)) {
    ctx.font = `bold 9px ${FONT_FAMILY}`;
    const deltaText = `(${formatSigned(card.achievementDelta!, 4)}%)`;
    drawOutlinedText(
      ctx,
      deltaText,
      achievementCursor + 2,
      y + 47,
      '#fff',
      '#000',
      1,
    );
    achievementCursor += ctx.measureText(deltaText).width + 2;
  }
  await drawRankChange(
    ctx,
    card,
    achievementCursor + 4,
    x + CARD_WIDTH - 8,
    y + 47,
  );

  ctx.font = `bold 13px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const dxText = formatDxScore(card.after.dxScore);
  drawOutlinedText(ctx, dxText, textX, y + 75, '#fff', '#000', 1);
  let dxCursor = textX + ctx.measureText(dxText).width;
  if (dxText !== 'N/A' && isNonZero(card.dxScoreDelta)) {
    ctx.font = `bold 10px ${FONT_FAMILY}`;
    const deltaText = `(${formatSigned(card.dxScoreDelta!, 0)})`;
    drawOutlinedText(ctx, deltaText, dxCursor + 1, y + 75, '#fff', '#000', 1);
    dxCursor += ctx.measureText(deltaText).width + 1;
  }
  dxCursor += 4;
  const statusCount =
    Number(Boolean(card.after.fc)) + Number(Boolean(card.after.fs));
  const right = x + CARD_WIDTH - 8;
  dxCursor = await drawStarChange(
    ctx,
    card,
    dxCursor,
    right - statusCount * 22,
    y + 75,
  );
  await drawCurrentStatuses(ctx, card, dxCursor + 2, right, y + 75);

  const type = await loadTypeAsset(card.type);
  if (type) {
    ctx.drawImage(type, x + 10, y + 101, 37, 17);
  }
  drawIdBadge(ctx, card.musicId, card.chartIndex, x + 51, y + 100);
  drawRatingBadge(ctx, card, x + 98, y + 100);

  ctx.font = `bold 10px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#6c757d';
  ctx.fillText(
    formatTime(card.observedAt, timeZone),
    x + CARD_WIDTH - 8,
    y + 110,
  );
}

async function drawRankChange(
  ctx: CanvasContext,
  card: HistoryExportCard,
  start: number,
  right: number,
  centerY: number,
) {
  const before = getRankFromScore(card.before.score ?? null);
  const after = getRankFromScore(card.after.score ?? null);
  if (!after) {
    return;
  }
  const changed = before !== null && before !== after;
  const desiredWidth = 63;
  const desiredHeight = 28;
  const desiredArrowWidth = 14;
  const naturalWidth = changed
    ? desiredWidth * 2 + desiredArrowWidth
    : desiredWidth;
  const scale = Math.min(1, Math.max(0, right - start) / naturalWidth);
  const iconWidth = desiredWidth * scale;
  const iconHeight = desiredHeight * scale;
  const arrowWidth = desiredArrowWidth * scale;
  const y = centerY - iconHeight / 2;
  let cursor = start;
  if (changed) {
    const beforeImage = await loadRankAsset(before);
    if (beforeImage) {
      ctx.drawImage(beforeImage, cursor, y, iconWidth, iconHeight);
    }
    cursor += iconWidth;
    ctx.font = `bold ${Math.max(6, 8 * scale)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    drawOutlinedText(
      ctx,
      '→',
      cursor + arrowWidth / 2,
      centerY,
      '#fff',
      '#000',
      1,
    );
    cursor += arrowWidth;
  }
  const afterImage = await loadRankAsset(after);
  if (afterImage) {
    ctx.drawImage(afterImage, cursor, y, iconWidth, iconHeight);
  }
}

async function drawStarChange(
  ctx: CanvasContext,
  card: HistoryExportCard,
  start: number,
  right: number,
  centerY: number,
): Promise<number> {
  const after = card.afterDxStar;
  if (!after || after <= 0) {
    return start;
  }
  const changed =
    card.beforeDxStar !== null &&
    card.beforeDxStar > 0 &&
    card.beforeDxStar !== after;
  const desiredWidth = 28;
  const desiredHeight = 16;
  const desiredArrowWidth = 8;
  const naturalWidth = changed
    ? desiredWidth * 2 + desiredArrowWidth
    : desiredWidth;
  const scale = Math.min(1, Math.max(0, right - start) / naturalWidth);
  const iconWidth = desiredWidth * scale;
  const iconHeight = desiredHeight * scale;
  const arrowWidth = desiredArrowWidth * scale;
  const y = centerY - iconHeight / 2;
  let cursor = start;
  if (changed) {
    const beforeImage = await loadDxScoreIconAsset(card.beforeDxStar!);
    if (beforeImage) {
      ctx.drawImage(beforeImage, cursor, y, iconWidth, iconHeight);
    }
    cursor += iconWidth;
    ctx.font = `bold ${Math.max(6, 8 * scale)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    drawOutlinedText(
      ctx,
      '→',
      cursor + arrowWidth / 2,
      centerY,
      '#fff',
      '#000',
      1,
    );
    cursor += arrowWidth;
  }
  const afterImage = await loadDxScoreIconAsset(after);
  if (afterImage) {
    ctx.drawImage(afterImage, cursor, y, iconWidth, iconHeight);
  }
  return cursor + iconWidth;
}

async function drawCurrentStatuses(
  ctx: CanvasContext,
  card: HistoryExportCard,
  start: number,
  right: number,
  centerY: number,
) {
  const fc = card.after.fc ? await loadFcAsset(card.after.fc) : null;
  const fs = card.after.fs ? await loadFsAsset(card.after.fs) : null;
  const count = Number(Boolean(fc)) + Number(Boolean(fs));
  const size = count > 0 ? Math.min(22, Math.max(0, right - start) / count) : 0;
  const y = centerY - size / 2;
  let cursor = start;
  if (fc) {
    ctx.drawImage(fc, cursor, y, size, size);
    cursor += size;
  }
  if (fs) {
    ctx.drawImage(fs, cursor, y, size, size);
  }
}

function drawIdBadge(
  ctx: CanvasContext,
  musicId: string,
  chartIndex: number,
  x: number,
  y: number,
) {
  const color = ID_COLORS[chartIndex] ?? '#555';
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 44, 19);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + 1, y + 1, 42, 17);
  ctx.font = `bold 10px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(`#${musicId}`, x + 22, y + 10);
}

function drawRatingBadge(
  ctx: CanvasContext,
  card: HistoryExportCard,
  x: number,
  y: number,
) {
  const rating = card.after.rating;
  const ratingText =
    typeof rating === 'number' ? Math.round(rating).toString() : 'N/A';
  const delta = isNonZero(card.ratingDelta)
    ? `(${formatSigned(card.ratingDelta!, 0)})`
    : '';
  const text = `${card.detailLevelText} → ${ratingText}${delta}`;
  ctx.fillStyle = '#868e96';
  ctx.fillRect(x, y, 82, 19);
  ctx.font = `bold 9px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(truncateText(ctx, text, 78), x + 41, y + 10);
}

function formatAchievement(value: string | null | undefined) {
  const parsed = value ? Number.parseFloat(value.replace('%', '')) : NaN;
  return Number.isFinite(parsed) ? `${parsed.toFixed(4)}%` : 'N/A';
}

function formatDxScore(value: string | null | undefined) {
  const parsed = value ? Number(value.replace(/,/g, '')) : NaN;
  if (!Number.isFinite(parsed)) {
    return 'N/A';
  }
  return Math.round(parsed).toLocaleString('en-US');
}

function formatSigned(value: number, digits: number) {
  const rounded =
    digits > 0 ? value.toFixed(digits) : Math.round(value).toString();
  return `${value >= 0 ? '+' : ''}${rounded}`;
}

function isNonZero(value: number | null, epsilon = Number.EPSILON) {
  return value !== null && Math.abs(value) >= epsilon;
}

function formatTime(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function drawOutlinedText(
  ctx: CanvasContext,
  text: string,
  x: number,
  y: number,
  fill: string,
  stroke = '#000',
  lineWidth = 2,
) {
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function drawRectOutline(
  ctx: CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, 1);
  ctx.fillRect(x, y + height - 1, width, 1);
  ctx.fillRect(x, y, 1, height);
  ctx.fillRect(x + width - 1, y, 1, height);
}
