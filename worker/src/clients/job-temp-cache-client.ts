/**
 * Job 临时缓存客户端
 * 用于在 update_score 阶段存储和恢复 FriendVS HTML 结果
 */

import { buildUrl } from "./job-service-client.ts";

/**
 * 获取缓存的 HTML
 * @returns HTML 字符串，如果缓存不存在则返回 null
 */
export async function getCachedHtml(
  jobId: string,
  diff: number,
  type: number,
): Promise<string | null> {
  try {
    const response = await fetch(
      buildUrl(`/api/job/${jobId}/cache/${diff}/${type}`),
    );

    if (response.status === 404 || response.status === 400) {
      return null;
    }

    if (!response.ok) {
      console.warn(
        `[JobTempCache] Failed to get cache for job ${jobId}, diff ${diff}, type ${type}. Status: ${response.status}`,
      );
      return null;
    }

    const data = (await response.json()) as { html: string };
    console.log(
      `[JobTempCache] Cache hit for job ${jobId}, diff ${diff}, type ${type}`,
    );
    return data.html;
  } catch (err) {
    console.warn(
      `[JobTempCache] Error getting cache for job ${jobId}, diff ${diff}, type ${type}:`,
      err,
    );
    return null;
  }
}

/**
 * 设置缓存
 */
export async function setCachedHtml(
  jobId: string,
  diff: number,
  type: number,
  html: string,
): Promise<void> {
  try {
    const response = await fetch(
      buildUrl(`/api/job/${jobId}/cache/${diff}/${type}`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html }),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(
        `[JobTempCache] Failed to set cache for job ${jobId}, diff ${diff}, type ${type}. Status: ${response.status}. Body: ${text}`,
      );
    } else {
      console.log(
        `[JobTempCache] Cache set for job ${jobId}, diff ${diff}, type ${type}`,
      );
    }
  } catch (err) {
    console.warn(
      `[JobTempCache] Error setting cache for job ${jobId}, diff ${diff}, type ${type}:`,
      err,
    );
  }
}
