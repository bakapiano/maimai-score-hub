import type { CompactCard } from '../score-export.types';
import { FONT_FAMILY, ID_COLORS, LEVEL_COLORS } from './score-export.constants';
import {
  type CanvasImage,
  loadFcAsset,
  loadFsAsset,
  loadDxScoreIconAsset,
  loadRankAsset,
  loadTypeAsset,
} from './score-export.assets';
import {
  CARD_IMG_H,
  CARD_IMG_W,
  CARD_STEP_X,
  CARD_STEP_Y,
  COLUMNS,
  type CanvasContext,
  type LoadCoverImage,
  drawStrokedText,
  getRankFromScore,
  truncateText,
} from './score-export.render-utils';

export async function drawCardGrid(
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

  if (diffBg) {
    ctx.drawImage(diffBg, x, y, CARD_IMG_W, CARD_IMG_H);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, CARD_IMG_W, CARD_IMG_H);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + 2, y + 2, CARD_IMG_W - 4, CARD_IMG_H - 4);
  }

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

  const textColor = card.chartIndex === 4 ? '#8a00e2' : '#ffffff';
  const textX = x + 93;
  const textMaxW = CARD_IMG_W - 93 - 8;

  ctx.font = `bold 14px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const title = truncateText(ctx, card.title, textMaxW);
  drawStrokedText(ctx, title, textX, y + 14, textColor, '#000', 2);

  const scoreText = card.score ?? 'N/A';
  ctx.font = `bold 22px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  drawStrokedText(ctx, scoreText, textX, y + 38, textColor, '#000', 2);

  const ds = card.detailLevelText;
  const ra = typeof card.rating === 'number' ? Math.round(card.rating) : '-';
  const dxScoreText =
    card.dxScore && card.dxScoreMax
      ? `${card.dxScore}/${card.dxScoreMax}`
      : (card.dxScore ?? null);
  ctx.font = `bold 15px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  drawStrokedText(
    ctx,
    truncateText(ctx, `${ds} → ${ra}`, dxScoreText ? 112 : textMaxW),
    textX,
    y + 65,
    textColor,
    '#000',
    2,
  );
  if (dxScoreText) {
    ctx.textAlign = 'center';
    drawStrokedText(ctx, dxScoreText, x + 219, y + 65, textColor, '#000', 2);
  }

  const typeImg = await loadTypeAsset(card.type);
  if (typeImg) {
    ctx.drawImage(typeImg, x + 51, y + 91, 37, 14);
  } else if (card.type === 'dx') {
    ctx.fillStyle = '#f97316';
    ctx.fillRect(x + 51, y + 91, 30, 14);
    ctx.fillStyle = '#fff';
    ctx.font = `bold 10px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DX', x + 66, y + 98);
  }

  const rank = getRankFromScore(card.score);
  if (rank) {
    const rankImg = await loadRankAsset(rank);
    if (rankImg) {
      ctx.drawImage(rankImg, x + 92, y + 78, 63, 28);
    } else {
      ctx.font = `bold 16px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      drawStrokedText(ctx, rank, x + 98, y + 82, '#f5d142', '#000', 2);
    }
  }

  if (card.fc) {
    const fcImg = await loadFcAsset(card.fc);
    if (fcImg) {
      ctx.drawImage(fcImg, x + 154, y + 77, 34, 34);
    } else {
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

  if (card.dxStar && card.dxStar > 0) {
    const dxStarImg = await loadDxScoreIconAsset(card.dxStar);
    if (dxStarImg) {
      ctx.drawImage(dxStarImg, x + 217, y + 80, 47, 26);
    }
  }

  const idColor = ID_COLORS[card.chartIndex] ?? textColor;
  ctx.font = `bold 13px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawStrokedText(ctx, card.musicId, x + 26, y + 98, idColor);
}
