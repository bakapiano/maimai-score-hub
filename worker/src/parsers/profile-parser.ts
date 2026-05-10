/**
 * 舞萌 DX 个人资料 HTML 解析器
 * 从 HTML 页面中提取用户信息
 */

import type { FriendInfo, UserProfile } from "../types/index.ts";

/**
 * 将舞萌网站的中国本地时间字符串（如 "2026/02/23 23:31"）转换为 ISO 8601 UTC 字符串。
 * 国服舞萌网站使用 CST (UTC+8)。
 */
function toISOFromCST(cstDateStr: string): string {
  const date = new Date(`${cstDateStr.replace(/\//g, "-")}:00+08:00`);
  return date.toISOString();
}

/**
 * 解析用户个人资料页面
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
  const title = titleMatch ? titleMatch[2] : null;

  const username = firstMatch(
    /<div class="name_block f_l f_16">([\s\S]*?)<\/div>/i,
  );

  if (username === null) {
    return null;
  }

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
 * 从好友列表页面解析好友总数
 * 匹配: <div class="basic_block m_3 p_3 f_11 l_h_10">好友数<br>1/100</div>
 * 返回好友数（斜杠前的数字），解析失败返回 null
 */
export function parseFriendCount(html: string): number | null {
  const match = html.match(
    /<div[^>]*class="basic_block[^"]*">好友数<br>(\d+)\/\d+<\/div>/i,
  );
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 解析好友列表页面，提取好友信息：friendCode、收藏状态、用户名、rating。
 *
 * 每个好友对应一个 see_through_block 块，块内顺序：
 *   <div class="trophy_block trophy_<color> ...">
 *     <div class="trophy_inner_block f_13">称号</div>
 *   </div>
 *   <div class="name_block t_l f_l f_16 underline">玩家名（全角）</div>
 *   <div class="rating_block">16029</div>
 *   <form action=".../favoriteOn/" or favoriteOff/" ...>
 *     <input type="hidden" name="idx" value="FRIEND_CODE">
 *   </form>
 *
 * 老调用方只读 friendCode + isFavorite；新加的 userName / rating 在
 * QR 登录流程里用于反向 map cabinetUserId → friendCode。
 */
export function parseFriendList(html: string): FriendInfo[] {
  // 一个块的开始：<div class="see_through_block ...">；下一个块（或文档其他东西）出现前
  // 就是它的范围。non-greedy 到下一个 see_through_block 起点。
  const blockRegex =
    /<div class="see_through_block[^"]*">([\s\S]*?)(?=<div class="see_through_block|<\/body>)/g;

  const seen = new Set<string>();
  const results: FriendInfo[] = [];
  for (const m of html.matchAll(blockRegex)) {
    const block = m[1];
    // friendCode is the source of truth — skip the block if we can't find it.
    const idxMatch = block.match(
      /<input type="hidden" name="idx" value="(.*?)"/,
    );
    if (!idxMatch) continue;
    const friendCode = idxMatch[1];
    if (seen.has(friendCode)) continue;
    seen.add(friendCode);

    // A friend block contains multiple <form>s (friendDetail, friendGenreVs,
    // favoriteOn/Off). We specifically want the favorite toggle one to
    // tell the current state — its action is favoriteOn/ when not yet
    // favorited, favoriteOff/ when already favorited.
    const favForm = block.match(
      /<form[^>]*action="[^"]*\/(favoriteOn|favoriteOff)\/[^"]*"/,
    );
    const isFavorite = favForm?.[1] === 'favoriteOff';

    const nameMatch = block.match(
      /<div class="name_block[^"]*">([\s\S]*?)<\/div>/,
    );
    const userName = nameMatch ? nameMatch[1].trim() : null;

    const ratingMatch = block.match(
      /<div class="rating_block">(\d+)<\/div>/,
    );
    const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null;

    results.push({ friendCode, isFavorite, userName, rating });
  }
  return results;
}

/**
 * 解析已发送的好友请求页面
 */
export function parseSentRequests(
  html: string,
): Array<{ friendCode: string; appliedAt: string | null }> {
  const blocks = html.match(
    /(<div class="see_through_block m_15 m_t_5 p_10 t_l f_0 p_r">[\s\S]*?)(?=<div class="see_through_block m_15 m_t_5 p_10 t_l f_0 p_r">|$)/g,
  );

  const requests: Array<{ friendCode: string; appliedAt: string | null }> = [];
  if (blocks) {
    for (const block of blocks) {
      const codeMatch = block.match(
        /<input type="hidden" name="idx" value="(.*?)"/i,
      );
      const dateMatch = block.match(/申请日期：([0-9/:\s]+)/);
      const friendCode = codeMatch?.[1];
      if (!friendCode) continue;
      requests.push({
        friendCode,
        appliedAt: dateMatch?.[1]?.trim()
          ? toISOFromCST(dateMatch[1].trim())
          : null,
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
    /<input type="hidden" name="idx" value="(.*?)"/g,
  );
  return [...new Set([...matches].map((x) => x[1]))];
}

/**
 * 解析用户好友代码页面
 */
export function parseUserFriendCode(html: string): string | null {
  const match = html.match(
    /<div class="see_through_block m_t_5 m_b_5 p_5 t_c f_15">(.*?)<\/div>/,
  );
  return match ? match[1] : null;
}
