/**
 * 将 friendRequestSentAt 格式化为 CST (UTC+8) 本地时间展示。
 * 兼容旧格式 "2026/02/23 23:31" 和 ISO 格式 "2026-02-23T15:31:00.000Z"。
 * 输出格式：YYYY/MM/DD HH:mm
 */
export function formatFriendRequestSentAt(dateStr: string): string {
  // 旧格式已经是 CST 本地时间展示，直接返回
  if (!dateStr.includes("T") && !dateStr.includes("Z")) {
    return dateStr;
  }

  // ISO 格式，转为 CST (UTC+8) 展示
  const date = new Date(dateStr);
  const cst = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = cst.getUTCFullYear();
  const m = String(cst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(cst.getUTCDate()).padStart(2, "0");
  const h = String(cst.getUTCHours()).padStart(2, "0");
  const min = String(cst.getUTCMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${h}:${min}`;
}
