import type {
  ChartEntry,
  CompactCard,
  LevelBucket,
  VersionBucket,
} from '../score-export.types';
import {
  DIFFICULTY_NAMES,
  FC_NAMES,
  FONT_FAMILY,
  FS_NAMES,
  LEVEL_COLORS,
} from './score-export.constants';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export type CanvasContext = ReturnType<
  ReturnType<typeof createCanvas>['getContext']
>;
export type CanvasImage = Awaited<ReturnType<typeof loadImage>>;
export type LoadCoverImage = (musicId: string) => Promise<CanvasImage | null>;

export async function renderBest50Image(
  payload: {
    total: number;
    newSum: number;
    oldSum: number;
    newCards: CompactCard[];
    oldCards: CompactCard[];
  },
  loadCoverImage: LoadCoverImage,
  loadIconImage: (icon: string) => Promise<CanvasImage | null>,
): Promise<Buffer> {
  const padding = 24;
  const sectionGap = 48; // Increased gap between sections
  const cardWidth = 160;
  const cardHeight = 215; // Height for cover + title + separator + score/rank rows
  const columns = 5;
  const gap = 12;
  const titleHeight = 40;
  const summaryHeight = 70;

  const newRows = Math.ceil(payload.newCards.length / columns) || 1;
  const oldRows = Math.ceil(payload.oldCards.length / columns) || 1;

  // Height calculation includes gap between rows
  const newGridHeight = newRows * cardHeight + (newRows - 1) * gap;
  const oldGridHeight = oldRows * cardHeight + (oldRows - 1) * gap;

  const width = padding * 2 + columns * cardWidth + gap * (columns - 1);
  const height =
    padding * 2 +
    summaryHeight +
    titleHeight +
    newGridHeight +
    sectionGap +
    titleHeight +
    oldGridHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 26px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Best 50', padding, padding);

  ctx.font = `bold 20px ${FONT_FAMILY}`;
  ctx.fillStyle = '#a5b4fc';
  ctx.fillText(`Rating: ${payload.total.toFixed(0)}`, padding, padding + 34);

  // Generation time (right aligned)
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  ctx.font = `14px ${FONT_FAMILY}`;
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.fillText(timeStr, width - padding, padding + 40);

  let cursorY = padding + summaryHeight;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 18px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.fillText(
    `现版本 Best 15 (${payload.newSum.toFixed(0)})`,
    padding,
    cursorY,
  );
  cursorY += titleHeight - 10;

  await drawCompactGrid(
    ctx,
    payload.newCards,
    padding,
    cursorY,
    columns,
    cardWidth,
    cardHeight,
    gap,
    loadCoverImage,
    loadIconImage,
  );
  cursorY += newGridHeight + sectionGap;

  // Draw separator line before "旧版本 Best 35"
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, cursorY - sectionGap / 2);
  ctx.lineTo(width - padding, cursorY - sectionGap / 2);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 18px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.fillText(
    `旧版本 Best 35 (${payload.oldSum.toFixed(0)})`,
    padding,
    cursorY,
  );
  cursorY += titleHeight - 10;

  await drawCompactGrid(
    ctx,
    payload.oldCards,
    padding,
    cursorY,
    columns,
    cardWidth,
    cardHeight,
    gap,
    loadCoverImage,
    loadIconImage,
  );

  return canvas.toBuffer('image/png');
}

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
  const sectionGap = 28; // Increased to prevent overlap with title

  let contentHeight = 0;
  bucket.details.forEach((detail) => {
    const rows = Math.max(1, Math.ceil(detail.items.length / columns));
    // Height = rows * cardSize + (rows - 1) * gap between rows
    const gridHeight = rows * cardSize + (rows - 1) * gap;
    contentHeight += headerHeight + gridHeight + sectionGap;
  });

  const width = padding * 2 + columns * cardSize + gap * (columns - 1);
  const height = padding * 2 + 60 + contentHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`等级 ${levelKey}`, padding, padding);

  let cursorY = padding + 48;

  for (const detail of bucket.details) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 16px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`定数 ${detail.detailKey}`, padding, cursorY);
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
    const gridHeight = rows * cardSize + (rows - 1) * gap;
    cursorY += gridHeight + sectionGap;
  }

  return canvas.toBuffer('image/png');
}

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
  const sectionGap = 28; // Increased to prevent overlap with title

  let contentHeight = 0;
  bucket.levels.forEach((level) => {
    const rows = Math.max(1, Math.ceil(level.items.length / columns));
    // Height = rows * cardSize + (rows - 1) * gap between rows
    const gridHeight = rows * cardSize + (rows - 1) * gap;
    contentHeight += headerHeight + gridHeight + sectionGap;
  });

  const width = padding * 2 + columns * cardSize + gap * (columns - 1);
  const height = padding * 2 + 60 + contentHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`版本 ${versionKey}`, padding, padding);

  let cursorY = padding + 48;

  for (const level of bucket.levels) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 16px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`等级 ${level.levelKey}`, padding, cursorY);
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
    const gridHeight = rows * cardSize + (rows - 1) * gap;
    cursorY += gridHeight + sectionGap;
  }

  return canvas.toBuffer('image/png');
}

async function drawCompactGrid(
  ctx: CanvasContext,
  cards: CompactCard[],
  startX: number,
  startY: number,
  columns: number,
  cardWidth: number,
  cardHeight: number,
  gap: number,
  loadCoverImage: LoadCoverImage,
  loadIconImage: (icon: string) => Promise<CanvasImage | null>,
) {
  for (let idx = 0; idx < cards.length; idx += 1) {
    const row = Math.floor(idx / columns);
    const col = idx % columns;
    const x = startX + col * (cardWidth + gap);
    const y = startY + row * (cardHeight + gap);

    const image = await loadCoverImage(cards[idx].musicId);
    const fcIcon = cards[idx].fc ? await loadIconImage(cards[idx].fc!) : null;
    const fsIcon = cards[idx].fs ? await loadIconImage(cards[idx].fs!) : null;
    drawCompactCard(ctx, x, y, cardWidth, cardHeight, {
      ...cards[idx],
      image,
      fcIcon,
      fsIcon,
    });
  }
}

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
  const images = await Promise.all(
    items.map(async (entry) => ({
      entry,
      image: await loadCoverImage(entry.music.id),
      fcIcon: entry.score?.fc ? await loadIconImage(entry.score.fc) : null,
      fsIcon: entry.score?.fs ? await loadIconImage(entry.score.fs) : null,
    })),
  );

  images.forEach(({ entry, image, fcIcon, fsIcon }, idx) => {
    const row = Math.floor(idx / columns);
    const col = idx % columns;
    const x = startX + col * (cardSize + gap);
    const y = startY + row * (cardSize + gap);
    drawMinimalCard(ctx, x, y, cardSize, entry, image ?? null, fcIcon, fsIcon);
  });
}

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
  return 'F';
}

function getRankFromScore(score: string | null) {
  const parsed = parseScore(score);
  return parsed !== null ? getRank(parsed) : 'N/A';
}

function drawRankText(ctx: CanvasContext, rank: string, x: number, y: number) {
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  if (rank === 'SSS' || rank === 'SSS+') {
    const parts = [
      { ch: 'S', color: '#f5d142' },
      { ch: 'S', color: '#4ea3ff' },
      { ch: 'S', color: '#ff4d4f' },
    ];
    const extra = rank.endsWith('+') ? [{ ch: '+', color: '#f5d142' }] : [];
    const text = parts.concat(extra);
    const width = ctx.measureText(rank).width;
    const startX = x - width / 2;
    let offset = 0;
    for (const part of text) {
      ctx.fillStyle = part.color;
      ctx.fillText(part.ch, startX + offset, y);
      offset += ctx.measureText(part.ch).width;
    }
    return;
  }

  if (['S', 'S+', 'SS', 'SS+'].includes(rank)) {
    ctx.fillStyle = '#f5d142';
  } else if (['A', 'AA', 'AAA'].includes(rank)) {
    ctx.fillStyle = '#ff4d4f';
  } else {
    ctx.fillStyle = '#ffffff';
  }
  ctx.fillText(rank, x, y);
}

function drawTextWithStroke(
  ctx: CanvasContext,
  text: string,
  x: number,
  y: number,
  fill: string,
  stroke = '#000',
  lineWidth = 3,
) {
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function drawCompactCard(
  ctx: CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  card: CompactCard & {
    image?: CanvasImage | null;
    fcIcon?: CanvasImage | null;
    fsIcon?: CanvasImage | null;
  },
) {
  const color = LEVEL_COLORS[card.chartIndex] ?? '#888';
  const borderWidth = 4;
  const coverPadding = 8;
  const coverSize = width - borderWidth * 2 - coverPadding * 2;
  const coverTopPadding = 8; // Same as left/right padding

  // Draw card background with border
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);

  const coverX = x + borderWidth + coverPadding;
  const coverY = y + borderWidth + coverTopPadding;

  // Draw cover with white border
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(coverX - 2, coverY - 2, coverSize + 4, coverSize + 4);

  // Draw cover background
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(coverX, coverY, coverSize, coverSize);

  // Draw cover image
  if (card.image) {
    ctx.drawImage(card.image, coverX, coverY, coverSize, coverSize);
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(coverX, coverY, coverSize, coverSize);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold 12px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No Cover', coverX + coverSize / 2, coverY + coverSize / 2);
  }

  // Draw glass blur overlay on cover
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(coverX, coverY, coverSize, coverSize);

  // Draw Rating badge (top left, black background)
  const ratingText = `Rating:${typeof card.rating === 'number' ? Math.round(card.rating) : '-'}`;
  ctx.font = `bold 10px ${FONT_FAMILY}`;
  const ratingWidth = ctx.measureText(ratingText).width + 12;
  const ratingBadgeHeight = 18;

  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  roundRect(ctx, coverX + 8, coverY + 8, ratingWidth, ratingBadgeHeight, 4);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    ratingText,
    coverX + 8 + ratingWidth / 2,
    coverY + 8 + ratingBadgeHeight / 2,
  );

  // Draw DX badge (top right)
  if (card.type === 'dx') {
    const dxBadgeWidth = 26;
    const dxBadgeHeight = 18;
    ctx.fillStyle = '#f97316';
    roundRect(
      ctx,
      coverX + coverSize - 8 - dxBadgeWidth,
      coverY + 8,
      dxBadgeWidth,
      dxBadgeHeight,
      4,
    );
    ctx.fillStyle = '#fff';
    ctx.font = `bold 11px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      'DX',
      coverX + coverSize - 8 - dxBadgeWidth / 2,
      coverY + 8 + dxBadgeHeight / 2,
    );
  }

  // Draw difficulty badge (bottom left) and level badge (bottom right)
  const badgeHeight = 18;
  const badgeY = coverY + coverSize - 8 - badgeHeight;

  // Difficulty name badge (left) - capitalize first letter only
  const diffNameRaw = DIFFICULTY_NAMES[card.chartIndex] ?? 'Unknown';
  const diffName =
    diffNameRaw.charAt(0).toUpperCase() + diffNameRaw.slice(1).toLowerCase();
  ctx.font = `bold 10px ${FONT_FAMILY}`;
  const diffWidth = ctx.measureText(diffName).width + 12;

  ctx.fillStyle = color;
  roundRect(ctx, coverX + 8, badgeY, diffWidth, badgeHeight, 4);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(diffName, coverX + 8 + diffWidth / 2, badgeY + badgeHeight / 2);

  // Level badge (right)
  const levelText = card.detailLevelText;
  const levelWidth = ctx.measureText(levelText).width + 12;

  ctx.fillStyle = color;
  roundRect(
    ctx,
    coverX + coverSize - 8 - levelWidth,
    badgeY,
    levelWidth,
    badgeHeight,
    4,
  );
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    levelText,
    coverX + coverSize - 8 - levelWidth / 2,
    badgeY + badgeHeight / 2,
  );

  // Draw title below cover
  const titleY = coverY + coverSize + 6;
  ctx.font = `bold 12px ${FONT_FAMILY}`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  drawTextWithStroke(
    ctx,
    truncateText(ctx, card.title, coverSize - 4),
    x + width / 2,
    titleY,
    '#fff',
    '#000',
    2,
  );

  // Draw dashed separator line using small rectangles (same width as cover)
  const separatorY = titleY + 18;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  const dashLength = 4;
  const dashGap = 3;
  let dashX = coverX;
  const dashEndX = coverX + coverSize;
  while (dashX < dashEndX) {
    const segmentLength = Math.min(dashLength, dashEndX - dashX);
    ctx.fillRect(dashX, separatorY, segmentLength, 1);
    dashX += dashLength + dashGap;
  }

  // Bottom section - Score on first line, Rank on second line, FC/FS icons on right
  const bottomY = separatorY + 6;

  // Left side: Score (first line)
  const scoreText = card.score ?? 'N/A';
  const rank = getRankFromScore(card.score);

  ctx.font = `bold 14px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Score in gold
  drawTextWithStroke(
    ctx,
    scoreText,
    x + borderWidth + 8,
    bottomY,
    '#f5d142',
    '#000',
    2,
  );

  // Rank on second line (where Rating used to be)
  ctx.font = `bold 14px ${FONT_FAMILY}`;
  drawRankTextLeft(ctx, rank, x + borderWidth + 8, bottomY + 16);

  // Right side: FC & FS icons - height matches two text lines (about 32px)
  const iconSize = 32;
  const iconGap = 0; // Gap between FC and FS icons
  const iconY = bottomY; // Align with top of score text
  const iconRightEdge = x + width - borderWidth - 6;

  // FS icon (right)
  const fsIconX = iconRightEdge - iconSize;
  if (card.fsIcon) {
    ctx.drawImage(card.fsIcon, fsIconX, iconY, iconSize, iconSize);
  } else {
    // Empty circle for no FS
    ctx.beginPath();
    ctx.arc(fsIconX + iconSize / 2, iconY + iconSize / 2, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // FC icon (left of FS, closer together)
  const fcIconX = fsIconX - iconSize - iconGap;
  if (card.fcIcon) {
    ctx.drawImage(card.fcIcon, fcIconX, iconY, iconSize, iconSize);
  } else {
    // Empty circle for no FC
    ctx.beginPath();
    ctx.arc(fcIconX + iconSize / 2, iconY + iconSize / 2, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Simple rectangle since canvas context type doesn't expose path methods properly
function roundRect(
  ctx: CanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  ..._rest: number[] // radius parameter kept for API compatibility
) {
  void _rest; // Suppress unused variable warning
  // Draw a simple filled rectangle as workaround for type issues
  ctx.fillRect(x, y, w, h);
}

function drawRankTextLeft(
  ctx: CanvasContext,
  rank: string,
  x: number,
  y: number,
) {
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  if (rank === 'SSS' || rank === 'SSS+') {
    const parts = [
      { ch: 'S', color: '#f5d142' },
      { ch: 'S', color: '#4ea3ff' },
      { ch: 'S', color: '#ff4d4f' },
    ];
    const extra = rank.endsWith('+') ? [{ ch: '+', color: '#f5d142' }] : [];
    const text = parts.concat(extra);
    let offset = 0;
    for (const part of text) {
      drawTextWithStroke(ctx, part.ch, x + offset, y, part.color, '#000', 2);
      offset += ctx.measureText(part.ch).width;
    }
    return;
  }

  let color = '#ffffff';
  if (['S', 'S+', 'SS', 'SS+'].includes(rank)) {
    color = '#f5d142';
  } else if (['A', 'AA', 'AAA'].includes(rank)) {
    color = '#ff4d4f';
  }
  drawTextWithStroke(ctx, rank, x, y, color, '#000', 2);
}

function truncateText(ctx: CanvasContext, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (
    trimmed.length > 0 &&
    ctx.measureText(`${trimmed}...`).width > maxWidth
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}...`;
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
  const borderWidth = 3; // Smaller border
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

  const scoreText = entry.score?.score || entry.score?.dxScore || null;
  const rank = getRankFromScore(scoreText);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(coverX, coverY, coverSize, coverSize);

  // Draw rank in center (moved up a bit more)
  ctx.font = `bold 18px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawRankText(ctx, rank, coverX + coverSize / 2, coverY + coverSize / 2 - 10);

  // Draw FC/FS icons at bottom (larger and moved up)
  const iconSize = 28;
  const iconY = coverY + coverSize - iconSize - 2;
  const iconGap = 2;

  // FC icon (left)
  const fcIconX = coverX + coverSize / 2 - iconSize - iconGap / 2;
  if (fcIcon) {
    ctx.drawImage(fcIcon, fcIconX, iconY, iconSize, iconSize);
  } else {
    ctx.beginPath();
    ctx.arc(fcIconX + iconSize / 2, iconY + iconSize / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = entry.score?.fc ? '#ffffff' : 'rgba(255,255,255,0.3)';
    ctx.fill();
  }

  // FS icon (right)
  const fsIconX = coverX + coverSize / 2 + iconGap / 2;
  if (fsIcon) {
    ctx.drawImage(fsIcon, fsIconX, iconY, iconSize, iconSize);
  } else {
    ctx.beginPath();
    ctx.arc(fsIconX + iconSize / 2, iconY + iconSize / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = entry.score?.fs ? '#ffffff' : 'rgba(255,255,255,0.3)';
    ctx.fill();
  }
}

function drawStatusBadge(
  ctx: CanvasContext,
  x: number,
  y: number,
  value: string | null | undefined,
  isFc: boolean,
) {
  const map = isFc ? FC_NAMES : FS_NAMES;
  const label = value ? map[value] || value.toUpperCase() : '';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fillStyle = value ? '#ffffff' : '#cbd5f5';
  ctx.fill();
  ctx.strokeStyle = '#94a3b8';
  ctx.stroke();

  if (label) {
    ctx.fillStyle = '#111827';
    ctx.font = `bold 8px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }
}
