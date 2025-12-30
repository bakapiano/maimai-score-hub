export interface FriendVsSong {
  level: string;
  name: string;
  score: string | null;
  category: string | null;
  kind: "dx" | "sd";
}

const songBlockAnchor =
  /<div class="music_(?:basic|advanced|expert|master|remaster|utage)_score_back/gi;
const categoryPattern = /<div class="screw_block[^>]*>([\s\S]*?)<\/div>/g;
const scoreCellPattern =
  /<td class="p_r (?:basic|advanced|expert|master|remaster|utage)_score_label w_120 f_b">\s*(?:<img[^>]*>\s*)*([0-9][0-9,]*(?:\.[0-9]+)?%?|―(?:\s*%)?)\s*<\/td>/gi;

export function parseFriendVsSongs(html: string): FriendVsSong[] {
  const songs: FriendVsSong[] = [];
  const categories = collectCategories(html);
  let categoryIndex = -1;
  let currentCategory: string | null = null;
  const blocks = collectSongBlocks(html);

  blocks.forEach(({ start, content }, idx) => {
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
    const kind: FriendVsSong["kind"] = /music_dx\.png/i.test(content)
      ? "dx"
      : "sd";
    // First score cell is the player's value; second is the opponent's.
    const opponentScore = normalizeScore(scoreMatches[1][1]);

    songs.push({
      level,
      name,
      score: opponentScore,
      category: currentCategory,
      kind,
    });
  });

  return songs;
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
