/**
 * 舞萌好友列表页面解析器。
 */

import { decodeHtmlEntities } from "@maimai-score-hub/shared";
import type { FriendInfo } from "../../types.ts";

/**
 * 从好友列表页面解析好友总数。
 */
export function parseFriendCount(html: string): number | null {
  const match = html.match(
    />好友数<\/span><br><span[^>]*>(\d+)<\/span>\/\d+/i,
  );
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 解析好友列表页面，提取好友信息。
 */
export function parseFriendList(html: string): FriendInfo[] {
  const blockRegex =
    /<div class="see_through_block[^"]*">([\s\S]*?)(?=<div class="see_through_block|<\/body>)/g;

  const seen = new Set<string>();
  const results: FriendInfo[] = [];
  for (const match of html.matchAll(blockRegex)) {
    const block = match[1];
    const idxMatch = block.match(
      /<input type="hidden" name="idx" value="(.*?)"/,
    );
    if (!idxMatch) continue;

    const friendCode = idxMatch[1];
    if (seen.has(friendCode)) continue;
    seen.add(friendCode);

    const favoriteForm = block.match(
      /<form[^>]*action="[^"]*\/(favoriteOn|favoriteOff)\/[^"]*"/,
    );
    const isFavorite = favoriteForm?.[1] === "favoriteOff";

    const nameMatch = block.match(
      /<div class="name_block[^"]*">([\s\S]*?)<\/div>/,
    );
    const userName = nameMatch
      ? decodeHtmlEntities(nameMatch[1].trim())
      : null;

    const ratingMatch = block.match(/<div class="rating_block">(\d+)<\/div>/);
    const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null;

    const avatarMatch = block.match(
      /<img(?=[^>]*class="w_112[^"]*")[^>]*src="([^"]+)"/i,
    );
    const avatarUrl = avatarMatch ? avatarMatch[1] : null;

    const titleBlockMatch = block.match(
      /<div class="trophy_block\s+([^"]*?)"[\s\S]*?<div class="trophy_inner_block[^"]*">\s*<span>([\s\S]*?)<\/span>/i,
    );
    const titleColor = titleBlockMatch
      ? (titleBlockMatch[1].match(/trophy_([A-Za-z0-9_-]+)/)?.[1] ?? null)
      : null;
    const title = titleBlockMatch
      ? decodeHtmlEntities(titleBlockMatch[2].trim())
      : null;

    const ratingBgMatch = block.match(
      /<img[^>]+src="([^"]+rating_base[^"]*)"[^>]*class="h_30 f_r"/i,
    );
    const ratingBgUrl = ratingBgMatch ? ratingBgMatch[1] : null;

    const courseRankMatch = block.match(
      /<img[^>]+src="([^"]+course\/course_rank[^"]*)"/i,
    );
    const courseRankUrl = courseRankMatch ? courseRankMatch[1] : null;

    const classRankMatch = block.match(
      /<img[^>]+src="([^"]+class\/class_rank[^"]*)"/i,
    );
    const classRankUrl = classRankMatch ? classRankMatch[1] : null;

    const awakeningMatch = block.match(/icon_star\.png[\s\S]*?>×(\d+)/i);
    const awakeningCount = awakeningMatch
      ? parseInt(awakeningMatch[1], 10)
      : null;

    results.push({
      friendCode,
      isFavorite,
      userName,
      rating,
      avatarUrl,
      title,
      titleColor,
      ratingBgUrl,
      courseRankUrl,
      classRankUrl,
      awakeningCount,
    });
  }

  return results;
}
