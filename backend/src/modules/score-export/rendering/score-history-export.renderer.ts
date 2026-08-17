import { createCanvas } from '@napi-rs/canvas';
import type { UserNetProfile } from '../../users/user.types';
import type { HistoryExportCard } from '../score-export.types';
import {
  type CanvasImage,
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
const CARD_HEIGHT = 127;
const CARD_STEP_X = 372;
const CARD_STEP_Y = 136;
const TOP_HEIGHT = 97;
const STATUS_ICON_SIZE = 23.86;
const EMPTY_STATUS_SIZE = 17.05;
const EMPTY_STATUS_ARROW_GAP = 1.7;
const STATUS_ARROW_WIDTH = 10.25;
const STATUS_GROUP_GAP = 1.704;

type StatusKind = 'fc' | 'fs';
type StatusChange = {
  kind: StatusKind;
  before: string | null;
  after: string;
  changed: boolean;
};

type CanvasGradientLike = {
  addColorStop: (offset: number, color: string) => void;
};

type AdvancedCanvasContext = {
  save: () => void;
  restore: () => void;
  clip: () => void;
  createLinearGradient: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => CanvasGradientLike;
  fillStyle: string | CanvasGradientLike;
};

type PathCanvasContext = {
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => void;
  closePath: () => void;
};

type FilterCanvasContext = {
  filter: string;
};

type Payload = {
  date: string;
  dayStartHour: number;
  timeZone: string;
  cards: HistoryExportCard[];
  profile: UserNetProfile | null;
  rating: number;
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
    payload.rating,
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

function beginHistoryCard(
  ctx: CanvasContext,
  x: number,
  y: number,
  levelColor: string,
) {
  const advancedCtx = ctx as unknown as AdvancedCanvasContext;
  advancedCtx.save();
  roundedRectPath(ctx, x, y, CARD_WIDTH, CARD_HEIGHT, 6);
  advancedCtx.clip();
  ctx.fillStyle = levelColor;
  ctx.fillRect(x, y, CARD_WIDTH, TOP_HEIGHT);
  const highlight = advancedCtx.createLinearGradient(
    x,
    y,
    x + CARD_WIDTH,
    y + TOP_HEIGHT,
  );
  highlight.addColorStop(0, 'rgba(255,255,255,0.10)');
  highlight.addColorStop(0.55, 'rgba(255,255,255,0)');
  advancedCtx.fillStyle = highlight;
  ctx.fillRect(x, y, CARD_WIDTH, TOP_HEIGHT);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y + TOP_HEIGHT, CARD_WIDTH, CARD_HEIGHT - TOP_HEIGHT);
  ctx.fillStyle = '#e9ecef';
  ctx.fillRect(x, y + TOP_HEIGHT, CARD_WIDTH, 1);
}

function finishHistoryCard(ctx: CanvasContext, x: number, y: number) {
  const advancedCtx = ctx as unknown as AdvancedCanvasContext;
  advancedCtx.restore();
  drawRoundedOutline(ctx, x, y, CARD_WIDTH, CARD_HEIGHT, 6, '#ccc');
}

async function drawHistoryCard(
  ctx: CanvasContext,
  card: HistoryExportCard,
  x: number,
  y: number,
  timeZone: string,
  loadCoverImage: LoadCoverImage,
) {
  beginHistoryCard(ctx, x, y, LEVEL_COLORS[card.chartIndex] ?? '#888');

  const cover = await loadCoverImage(card.musicId);
  if (cover) {
    ctx.drawImage(cover, x + 9.516, y + 9.516, 76.703, 76.703);
  } else {
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(x + 9.516, y + 9.516, 76.703, 76.703);
  }

  const textX = x + 94.734;
  const textWidth = CARD_WIDTH - 104.25;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 14px ${FONT_FAMILY}`;
  drawOutlinedText(
    ctx,
    truncateText(ctx, card.title, textWidth),
    textX,
    y + 17,
    '#fff',
  );
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(textX, y + 31.5, x + CARD_WIDTH - 9.5 - textX, 1);

  ctx.font = `bold 19px ${FONT_FAMILY}`;
  const achievement = formatAchievement(card.after.score);
  drawOutlinedText(ctx, achievement, textX, y + 47, '#fff');
  let achievementCursor = textX + ctx.measureText(achievement).width;
  if (isNonZero(card.achievementDelta, 0.00005)) {
    ctx.font = `bold 10px ${FONT_FAMILY}`;
    const deltaText = `(${formatSigned(card.achievementDelta!, 4)}%)`;
    drawOutlinedText(
      ctx,
      deltaText,
      achievementCursor + 1,
      y + 47,
      '#ffe066',
      '#000',
      2,
    );
    achievementCursor += ctx.measureText(deltaText).width + 1;
  }
  await drawRankChange(
    ctx,
    card,
    achievementCursor + 4,
    x + CARD_WIDTH - 9.5,
    y + 47,
  );

  ctx.font = `bold 13px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const dxText = formatDxScore(card.after.dxScore);
  drawOutlinedText(ctx, dxText, textX, y + 74.25, '#fff', '#000', 2);
  let dxCursor = textX + ctx.measureText(dxText).width;
  if (dxText !== 'N/A' && isNonZero(card.dxScoreDelta)) {
    ctx.font = `bold 10px ${FONT_FAMILY}`;
    const deltaText = `(${formatSigned(card.dxScoreDelta!, 0)})`;
    drawOutlinedText(
      ctx,
      deltaText,
      dxCursor + 1,
      y + 74.25,
      '#ffe066',
      '#000',
      2,
    );
    dxCursor += ctx.measureText(deltaText).width + 1;
  }
  const statusChanges = getStatusChanges(card);
  const statusWidth = getStatusChangesNaturalWidth(statusChanges);
  dxCursor -= 0.17;
  const right = x + CARD_WIDTH - 9.515;
  dxCursor = await drawStarChange(
    ctx,
    card,
    dxCursor,
    right - statusWidth,
    y + 74.25,
  );
  await drawStatusChanges(ctx, statusChanges, dxCursor, right, y + 74.25);

  const type = await loadTypeAsset(card.type);
  if (type) {
    ctx.drawImage(type, x + 9.516, y + 101.203, 50.172, 18.75);
  }
  drawIdBadge(ctx, card.musicId, card.chartIndex, x + 63.938, y + 101.203);
  drawRatingBadge(ctx, card, x + 115.641, y + 101.203);

  ctx.font = `bold 9.4px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#6c757d';
  const time = formatTime(card.observedAt, timeZone);
  const timeRight = x + CARD_WIDTH - 9.515;
  ctx.fillText(time, timeRight, y + 111.75);
  if (card.isNew) {
    const timeLeft = timeRight - ctx.measureText(time).width;
    drawNewBadge(ctx, timeLeft - 33.45, y + 102.9);
  }
  finishHistoryCard(ctx, x, y);
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
  const desiredWidth = 41;
  const desiredHeight = 19;
  const desiredArrowWidth = 10.25;
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
      drawImageWithOutline(ctx, beforeImage, cursor, y, iconWidth, iconHeight);
    }
    cursor += iconWidth;
    ctx.font = `bold ${Math.max(7, 13 * scale)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    drawOutlinedText(
      ctx,
      '→',
      cursor + arrowWidth / 2,
      centerY,
      '#fff',
      '#000',
      2,
    );
    cursor += arrowWidth;
  }
  const afterImage = await loadRankAsset(after);
  if (afterImage) {
    drawImageWithOutline(ctx, afterImage, cursor, y, iconWidth, iconHeight);
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
  const desiredWidth = 32.391;
  const desiredHeight = 18.75;
  const desiredArrowWidth = 10.25;
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
      drawImageWithOutline(ctx, beforeImage, cursor, y, iconWidth, iconHeight);
    }
    cursor += iconWidth;
    ctx.font = `bold ${Math.max(7, 13 * scale)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    drawOutlinedText(
      ctx,
      '→',
      cursor + arrowWidth / 2,
      centerY,
      '#fff',
      '#000',
      2,
    );
    cursor += arrowWidth;
  }
  const afterImage = await loadDxScoreIconAsset(after);
  if (afterImage) {
    drawImageWithOutline(ctx, afterImage, cursor, y, iconWidth, iconHeight);
  }
  return cursor + iconWidth;
}

function normalizeStatus(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function getStatusChanges(card: HistoryExportCard): StatusChange[] {
  return (['fc', 'fs'] as const).flatMap((kind) => {
    const after = normalizeStatus(card.after[kind]);
    if (!after) {
      return [];
    }
    const before = normalizeStatus(card.before[kind]);
    return [{ kind, before, after, changed: before !== after }];
  });
}

function getStatusChangesNaturalWidth(changes: StatusChange[]) {
  if (changes.length === 0) {
    return 0;
  }
  const contentWidth = changes.reduce(
    (width, change) =>
      width +
      (change.changed
        ? (change.before ? STATUS_ICON_SIZE : EMPTY_STATUS_SIZE) +
          (change.before ? 0 : EMPTY_STATUS_ARROW_GAP) +
          STATUS_ICON_SIZE +
          STATUS_ARROW_WIDTH
        : STATUS_ICON_SIZE),
    0,
  );
  return contentWidth + STATUS_GROUP_GAP * (changes.length - 1);
}

function loadStatusAsset(kind: StatusKind, value: string) {
  return kind === 'fc' ? loadFcAsset(value) : loadFsAsset(value);
}

async function drawStatusChanges(
  ctx: CanvasContext,
  changes: StatusChange[],
  start: number,
  right: number,
  centerY: number,
) {
  const naturalWidth = getStatusChangesNaturalWidth(changes);
  if (naturalWidth === 0) {
    return;
  }
  const scale = Math.min(1, Math.max(0, right - start) / naturalWidth);
  const size = STATUS_ICON_SIZE * scale;
  const arrowWidth = STATUS_ARROW_WIDTH * scale;
  const groupGap = STATUS_GROUP_GAP * scale;
  const y = centerY - size / 2;
  let cursor = start;

  for (const [index, change] of changes.entries()) {
    if (index > 0) {
      cursor += groupGap;
    }
    if (change.changed) {
      if (change.before) {
        const beforeImage = await loadStatusAsset(change.kind, change.before);
        if (beforeImage) {
          ctx.drawImage(beforeImage, cursor, y, size, size);
        }
        cursor += size;
      } else {
        const emptySize = EMPTY_STATUS_SIZE * scale;
        drawEmptyStatusDot(ctx, cursor, centerY, emptySize, scale);
        cursor += emptySize + EMPTY_STATUS_ARROW_GAP * scale;
      }
      ctx.font = `bold ${Math.max(7, 13 * scale)}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      drawOutlinedText(
        ctx,
        '→',
        cursor + arrowWidth / 2,
        centerY,
        '#fff',
        '#000',
        2,
      );
      cursor += arrowWidth;
    }
    const afterImage = await loadStatusAsset(change.kind, change.after);
    if (afterImage) {
      ctx.drawImage(afterImage, cursor, y, size, size);
    }
    cursor += size;
  }
}

function drawEmptyStatusDot(
  ctx: CanvasContext,
  x: number,
  centerY: number,
  diameter: number,
  scale: number,
) {
  ctx.beginPath();
  ctx.arc(x + diameter / 2, centerY, diameter / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.fill();
  ctx.lineWidth = Math.max(0.5, scale);
  ctx.strokeStyle = 'rgba(204,204,204,0.62)';
  ctx.stroke();
}

function drawImageWithOutline(
  ctx: CanvasContext,
  image: CanvasImage,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const filterCtx = ctx as unknown as FilterCanvasContext;
  const previousFilter = filterCtx.filter;
  filterCtx.filter =
    'drop-shadow(-1px 0 0 #111) drop-shadow(1px 0 0 #111) ' +
    'drop-shadow(0 -1px 0 #111) drop-shadow(0 1px 0 #111)';
  ctx.drawImage(image, x, y, width, height);
  filterCtx.filter = previousFilter;
}

function drawIdBadge(
  ctx: CanvasContext,
  musicId: string,
  chartIndex: number,
  x: number,
  y: number,
) {
  const color = ID_COLORS[chartIndex] ?? '#555';
  fillRoundedRect(ctx, x, y, 47.453, 18.75, 2, color);
  fillRoundedRect(ctx, x + 1, y + 1, 45.453, 16.75, 1, '#fff');
  ctx.font = `bold 9.4px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(`#${musicId}`, x + 23.7265, y + 9.375);
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
  const baseText = `${card.detailLevelText} → ${ratingText}`;
  fillRoundedRect(ctx, x, y, 85.141, 18.75, 4, '#868e96');
  ctx.font = `bold 9.4px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  const maxWidth = 81.141;
  const deltaWidth = ctx.measureText(delta).width;
  const renderedBase = truncateText(
    ctx,
    baseText,
    Math.max(0, maxWidth - deltaWidth),
  );
  const baseWidth = ctx.measureText(renderedBase).width;
  const start = x + (85.141 - baseWidth - deltaWidth) / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.fillText(renderedBase, start, y + 9.375);
  if (delta) {
    ctx.fillStyle = '#ffe066';
    ctx.fillText(delta, start + baseWidth, y + 9.375);
  }
}

function drawNewBadge(ctx: CanvasContext, x: number, y: number) {
  fillRoundedRect(ctx, x, y, 29.203, 15.344, 7.672, '#e8f7f9');
  ctx.font = `bold 9.4px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0b7285';
  ctx.fillText('NEW', x + 14.6015, y + 7.672);
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
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

function roundedRectPath(
  ctx: CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const pathCtx = ctx as unknown as PathCanvasContext;
  const right = x + width;
  const bottom = y + height;
  pathCtx.beginPath();
  pathCtx.moveTo(x + radius, y);
  pathCtx.lineTo(right - radius, y);
  pathCtx.quadraticCurveTo(right, y, right, y + radius);
  pathCtx.lineTo(right, bottom - radius);
  pathCtx.quadraticCurveTo(right, bottom, right - radius, bottom);
  pathCtx.lineTo(x + radius, bottom);
  pathCtx.quadraticCurveTo(x, bottom, x, bottom - radius);
  pathCtx.lineTo(x, y + radius);
  pathCtx.quadraticCurveTo(x, y, x + radius, y);
  pathCtx.closePath();
}

function fillRoundedRect(
  ctx: CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
) {
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawRoundedOutline(
  ctx: CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
) {
  roundedRectPath(ctx, x + 0.5, y + 0.5, width - 1, height - 1, radius - 0.5);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
}
