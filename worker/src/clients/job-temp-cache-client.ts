/**
 * Job 临时缓存客户端
 * 用于在 update_score 阶段存储和恢复 FriendVS HTML 结果
 */

import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";

import { getJobServiceBaseUrl } from "./job-service-client.ts";

const { jobContract } = sharedContract;

const client = initClient(jobContract, {
  baseUrl: `${getJobServiceBaseUrl()}/api`,
});

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
    const response = await client.getTempCache({
      params: { jobId, diff: String(diff), type: String(type) },
    });

    if (response.status === 404 || response.status === 400) {
      return null;
    }

    if (response.status !== 200) {
      console.warn(
        `[JobTempCache] Failed to get cache for job ${jobId}, diff ${diff}, type ${type}. Status: ${response.status}`,
      );
      return null;
    }

    console.log(
      `[JobTempCache] Cache hit for job ${jobId}, diff ${diff}, type ${type}`,
    );
    return response.body.html;
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
    const response = await client.setTempCache({
      params: { jobId, diff: String(diff), type: String(type) },
      body: { html },
    });

    if (response.status !== 201) {
      console.warn(
        `[JobTempCache] Failed to set cache for job ${jobId}, diff ${diff}, type ${type}. Status: ${response.status}`,
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
