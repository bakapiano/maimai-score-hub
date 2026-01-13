/**
 * Friend VS 页面解析器
 * 从 Friend VS HTML 页面中提取歌曲成绩信息
 */

import type { FriendVsSong, ChartType } from "../types/index.ts";

// Re-export type for backward compatibility
export type { FriendVsSong };

const songBlockAnchor =
  /<div class="music_(?:basic|advanced|expert|master|remaster|utage)_score_back/gi;
const categoryPattern = /<div class="screw_block[^>]*>([\s\S]*?)<\/div>/g;
const scoreCellPattern =
  /<td class="p_r (?:basic|advanced|expert|master|remaster|utage)_score_label w_120 f_b">\s*(?:<img[^>]*>\s*)*([0-9][0-9,]*(?:\.[0-9]+)?%?|―(?:\s*%)?)\s*<\/td>/gi;

/**
 * 解析 Friend VS 页面中的歌曲列表
 */
export function parseFriendVsSongs(html: string): FriendVsSong[] {
  const songs: FriendVsSong[] = [];
  const categories = collectCategories(html);
  let categoryIndex = -1;
  let currentCategory: string | null = null;
  const blocks = collectSongBlocks(html);

  blocks.forEach(({ start, content }) => {
    const songStart = start;
    while (
      categoryIndex + 1 < categories.length &&
      categories[categoryIndex + 1].start <= songStart
    ) {
      categoryIndex += 1;
      currentCategory = categories[categoryIndex].name;
    }

    const levelMatch = /<div class="music_lv_block[^>]*>([\s\S]*?)<\/div>/.exec(
      content
    );
    const nameMatch =
      /<div class="music_name_block[^>]*>([\s\S]*?)<\/div>/.exec(content);
    const scoreMatches = [...content.matchAll(cloneRegex(scoreCellPattern))];

    if (!levelMatch || !nameMatch || scoreMatches.length < 2) {
      return;
    }

    const level = normalizeText(levelMatch[1]);
    const name = normalizeText(nameMatch[1]);
    const type: ChartType = /music_utage\.png/i.test(content)
      ? "utage"
      : /music_dx\.png/i.test(content)
      ? "dx"
      : "standard";
    const { fs, fc } = extractFsFcBadges(content);
    // First score cell is the player's value; second is the opponent's.
    const opponentScore = normalizeScore(scoreMatches[1][1]);

    songs.push({
      level,
      name,
      score: opponentScore,
      category: currentCategory,
      type,
      fs,
      fc,
    });
  });

  return songs;
}

function extractFsFcBadges(content: string): {
  fs: string | null;
  fc: string | null;
} {
  const tdRegex = /<td class="t_r f_0">([\s\S]*?)<\/td>/gi;
  const iconRegex = /music_icon_([a-z0-9]+)\.png/gi;

  let rightCellInnerHtml: string | null = null;
  for (const match of content.matchAll(tdRegex)) {
    const inner = match[1] ?? "";
    // Use a fresh regex instance to avoid leaking lastIndex across uses.
    if (cloneRegex(iconRegex).test(inner)) {
      rightCellInnerHtml = inner;
      break;
    }
  }

  if (!rightCellInnerHtml) {
    return { fs: null, fc: null };
  }

  const iconsInDomOrder: (string | null)[] = [];
  // clone to ensure we start matching from index 0 every time
  for (const match of rightCellInnerHtml.matchAll(cloneRegex(iconRegex))) {
    const icon = match[1].toLowerCase();
    iconsInDomOrder.push(icon === "back" ? null : icon);
  }

  return {
    fs: iconsInDomOrder[0] ?? null,
    fc: iconsInDomOrder[1] ?? null,
  };
}

// Records where each category banner appears so subsequent songs inherit it until the next banner.
function collectCategories(
  html: string
): Array<{ start: number; name: string }> {
  const categories: { start: number; name: string }[] = [];
  let match: RegExpExecArray | null;
  const categoryRegex = cloneRegex(categoryPattern);
  while ((match = categoryRegex.exec(html)) !== null) {
    categories.push({
      start: match.index ?? 0,
      name: normalizeText(match[1]),
    });
  }
  return categories;
}

function collectSongBlocks(
  html: string
): Array<{ start: number; content: string }> {
  const blocks: Array<{ start: number; content: string }> = [];
  const anchorRegex = cloneRegex(songBlockAnchor);
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    indices.push(match.index ?? 0);
  }

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : html.length;
    blocks.push({ start, content: html.slice(start, end) });
  }

  return blocks;
}

function cloneRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

function normalizeText(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return decodeHtml(trimmed);
}

function normalizeScore(value: string): string | null {
  const cleaned = value.replace(/[\s,]/g, "");
  if (!cleaned || cleaned === "―" || cleaned === "―%") {
    return null;
  }
  return cleaned;
}

function decodeHtml(content: string): string {
  return content
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([\da-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}
