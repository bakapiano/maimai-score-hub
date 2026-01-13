/**
 * 舞萌 DX 个人资料 HTML 解析器
 * 从 HTML 页面中提取用户信息
 */

import type { UserProfile } from "../types/index.ts";

/**
 * 解析用户个人资料页面
 */
export function parseUserProfile(html: string): UserProfile | null {
  const firstMatch = (re: RegExp): string | null => {
    const m = html.match(re);
    return m ? m[1] : null;
  };

  const avatarUrl = firstMatch(
    /<img(?=[^>]*class="w_112 f_l")[^>]*src="([^"]+)"/i
  );

  const titleMatch = html.match(
    /<div class="trophy_block\s+([^\"]*?)"[\s\S]*?<div class="trophy_inner_block[^"]*">\s*<span>(.*?)<\/span>/i
  );
  const titleColor = titleMatch
    ? titleMatch[1].match(/trophy_([A-Za-z0-9_-]+)/)?.[1] ?? null
    : null;
  const title = titleMatch ? titleMatch[2] : null;

  const username = firstMatch(
    /<div class="name_block f_l f_16">([\s\S]*?)<\/div>/i
  );

  if (username === null) {
    return null;
  }

  const ratingBgUrl = firstMatch(
    /<img[^>]+src="([^"]+rating_base[^"]*)"[^>]*class="h_30 f_r"/i
  );
  const ratingStr = firstMatch(/<div class="rating_block">(\d+)<\/div>/i);
  const rating = ratingStr ? parseInt(ratingStr, 10) : null;

  const courseRankUrl = firstMatch(
    /<img[^>]+src="([^"]+course\/course_rank[^"]*)"[^>]*class="h_35 f_l"/i
  );
  const classRankUrl = firstMatch(
    /<img[^>]+src="([^"]+class\/class_rank[^"]*)"[^>]*class="p_l_10 h_35 f_l"/i
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
 * 解析好友列表页面，提取好友代码列表
 */
export function parseFriendList(html: string): string[] {
  const matches = html.matchAll(
    /<input type="hidden" name="idx" value="(.*?)"/g
  );
  return [...new Set([...matches].map((x) => x[1]))];
}

/**
 * 解析已发送的好友请求页面
 */
export function parseSentRequests(
  html: string
): Array<{ friendCode: string; appliedAt: string | null }> {
  const blocks = html.match(
    /(<div class="see_through_block m_15 m_t_5 p_10 t_l f_0 p_r">[\s\S]*?)(?=<div class="see_through_block m_15 m_t_5 p_10 t_l f_0 p_r">|$)/g
  );

  const requests: Array<{ friendCode: string; appliedAt: string | null }> = [];
  if (blocks) {
    for (const block of blocks) {
      const codeMatch = block.match(
        /<input type="hidden" name="idx" value="(.*?)"/i
      );
      const dateMatch = block.match(/申请日期：([0-9/:\s]+)/);
      const friendCode = codeMatch?.[1];
      if (!friendCode) continue;
      requests.push({
        friendCode,
        appliedAt: dateMatch?.[1]?.trim() || null,
      });
    }
  }

  return requests;
}

/**
 * 解析待接受的好友请求页面
 */
export function parseAcceptRequests(html: string): string[] {
  const matches = html.matchAll(
    /<input type="hidden" name="idx" value="(.*?)"/g
  );
  return [...new Set([...matches].map((x) => x[1]))];
}

/**
 * 解析用户好友代码页面
 */
export function parseUserFriendCode(html: string): string | null {
  const match = html.match(
    /<div class="see_through_block m_t_5 m_b_5 p_5 t_c f_15">(.*?)<\/div>/
  );
  return match ? match[1] : null;
}
