/**
 * 舞萌好友请求页面解析器。
 */

import type { AcceptFriendRequest, SentFriendRequest } from "../../types.ts";

function toISOFromCST(cstDateStr: string): string {
  const date = new Date(`${cstDateStr.replace(/\//g, "-")}:00+08:00`);
  return date.toISOString();
}

/**
 * 解析已发送的好友请求页面。
 */
export function parseSentRequests(html: string): SentFriendRequest[] {
  const requests: SentFriendRequest[] = [];

  for (const block of collectRequestBlocks(html)) {
    const friendCode = extractFriendCode(block);
    if (!friendCode) continue;

    requests.push({
      friendCode,
      appliedAt: extractAppliedAt(block),
    });
  }

  return requests;
}

/**
 * 解析待接受的好友请求页面。
 */
export function parseAcceptRequests(html: string): AcceptFriendRequest[] {
  const seen = new Set<string>();
  const requests: AcceptFriendRequest[] = [];

  for (const block of collectRequestBlocks(html)) {
    const friendCode = extractFriendCode(block);
    if (!friendCode || seen.has(friendCode)) continue;
    seen.add(friendCode);

    requests.push({
      friendCode,
      appliedAt: extractAppliedAt(block),
    });
  }

  return requests;
}

/**
 * 解析好友搜索页是否显示“已收到该用户好友申请”状态。
 */
export function parseHasReceivedFriendRequest(html: string): boolean {
  return getFriendSearchRelationText(html) === "收到的好友申请";
}

/**
 * 解析好友搜索页是否显示“已发送好友申请”状态。
 */
export function parseHasSentFriendRequest(html: string): boolean {
  return getFriendSearchRelationText(html) === "申请中的好友";
}

/**
 * 解析好友搜索页是否显示“已经是好友”状态。
 */
export function parseIsFriendFromSearchPage(html: string): boolean {
  const relationText = getFriendSearchRelationText(html);
  if (
    relationText !== null &&
    relationText.includes("好友") &&
    !relationText.includes("申请")
  ) {
    return true;
  }
  return false;
}

function collectRequestBlocks(html: string): string[] {
  return (
    html.match(
      /(<div class="see_through_block m_15 m_t_5 p_10 t_l f_0 p_r">[\s\S]*?)(?=<div class="see_through_block m_15 m_t_5 p_10 t_l f_0 p_r">|$)/g,
    ) ?? []
  );
}

function extractFriendCode(block: string): string | null {
  const codeMatch = block.match(
    /<input type="hidden" name="idx" value="(.*?)"/i,
  );
  return codeMatch?.[1] ?? null;
}

function extractAppliedAt(block: string): string | null {
  const dateMatch = block.match(/申请日期：([0-9/:\s]+)/);
  return dateMatch?.[1]?.trim() ? toISOFromCST(dateMatch[1].trim()) : null;
}

function getFriendSearchRelationText(html: string): string | null {
  const match = html.match(
    /<div class="t_r m_t_5 gray f_13">\s*([^<]+?)\s*<img[^>]+icon_each\.png/i,
  );
  return match?.[1]?.trim() ?? null;
}
