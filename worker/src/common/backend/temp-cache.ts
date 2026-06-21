/**
 * Job 临时缓存客户端
 * 用于在 update_score 阶段存储和恢复 FriendVS 临时结果
 */

import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";

import { getJobServiceBaseUrl } from "./jobs.ts";
import { backendTsRestApi } from "./http.ts";
import type { FriendVsSong } from "../types.ts";

const { jobContract } = sharedContract;

const client = initClient(jobContract, {
  baseUrl: `${getJobServiceBaseUrl()}/api/v1`,
  api: backendTsRestApi,
});

/**
 * 获取缓存的 FriendVS 解析结果
 */
export async function getCachedFriendVsSongs(
  jobId: string,
  diff: number,
  type: number,
): Promise<FriendVsSong[] | null> {
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
    return response.body.songs;
  } catch (err) {
    console.warn(
      `[JobTempCache] Error getting cache for job ${jobId}, diff ${diff}, type ${type}:`,
      err,
    );
    return null;
  }
}

/**
 * 设置缓存的 FriendVS 解析结果
 */
export async function setCachedFriendVsSongs(
  jobId: string,
  diff: number,
  type: number,
  songs: FriendVsSong[],
): Promise<void> {
  try {
    const response = await client.setTempCache({
      params: { jobId, diff: String(diff), type: String(type) },
      body: { songs },
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
