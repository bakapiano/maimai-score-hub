/**
 * 舞萌用户资料相关页面解析器。
 */

import { decodeHtmlEntities } from "@maimai-score-hub/shared";
import type { UserProfile } from "../../types.ts";

/**
 * 解析用户个人资料页面。
 */
export function parseUserProfile(html: string): UserProfile | null {
  const firstMatch = (re: RegExp): string | null => {
    const m = html.match(re);
    return m ? m[1] : null;
  };

  const avatarUrl = firstMatch(
    /<img(?=[^>]*class="w_112 f_l")[^>]*src="([^"]+)"/i,
  );

  const titleMatch = html.match(
    /<div class="trophy_block\s+([^\"]*?)"[\s\S]*?<div class="trophy_inner_block[^"]*">\s*<span>(.*?)<\/span>/i,
  );
  const titleColor = titleMatch
    ? (titleMatch[1].match(/trophy_([A-Za-z0-9_-]+)/)?.[1] ?? null)
    : null;
  const title = titleMatch ? decodeHtmlEntities(titleMatch[2]) : null;

  const usernameRaw = firstMatch(
    /<div class="name_block f_l f_16">([\s\S]*?)<\/div>/i,
  );

  if (usernameRaw === null) {
    return null;
  }
  const username = decodeHtmlEntities(usernameRaw);

  const ratingBgUrl = firstMatch(
    /<img[^>]+src="([^"]+rating_base[^"]*)"[^>]*class="h_30 f_r"/i,
  );
  const ratingStr = firstMatch(/<div class="rating_block">(\d+)<\/div>/i);
  const rating = ratingStr ? parseInt(ratingStr, 10) : null;

  const courseRankUrl = firstMatch(
    /<img[^>]+src="([^"]+course\/course_rank[^"]*)"[^>]*class="h_35 f_l"/i,
  );
  const classRankUrl = firstMatch(
    /<img[^>]+src="([^"]+class\/class_rank[^"]*)"[^>]*class="p_l_10 h_35 f_l"/i,
  );

  const awakeningCountStr = firstMatch(/icon_star\.png[\s\S]*?>×(\d+)/i);
  const awakeningCount = awakeningCountStr
    ? parseInt(awakeningCountStr, 10)
    : null;

  return {
    avatarUrl,
    title,
    titleColor,
    username,
    rating,
    ratingBgUrl,
    courseRankUrl,
    classRankUrl,
    awakeningCount,
  };
}

/**
 * 解析用户好友代码页面。
 */
export function parseUserFriendCode(html: string): string | null {
  const match = html.match(
    /<div class="see_through_block m_t_5 m_b_5 p_5 t_c f_15">(.*?)<\/div>/,
  );
  return match ? match[1] : null;
}
