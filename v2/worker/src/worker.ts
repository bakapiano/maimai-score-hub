import type { Job, JobPatch } from "./job-service-client.ts";
import {
  allowFriendRequest,
  cancelFriendRequest,
  favoriteOnFriend,
  getAccpetRequests,
  getFriendList,
  getFriendVS,
  getSentRequests,
  getUserProfile,
  removeFriend,
  searchUserByFriendCode,
  sendFriendRequest,
  type SentRequest,
} from "./crawler.ts";
import { claimNextJob, updateJob } from "./job-service-client.ts";
import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { CookieExpiredError } from "./util.ts";
import { loadCookie } from "./cookie.ts";
import { parseFriendVsSongs } from "./friend-vs-parser.ts";
import { randomUUID } from "node:crypto";
import { state } from "./state.ts";

let friendVsDumpReady: Promise<void> | null = null;

const useMockResult =
  process.env.USE_MOCK_RESULT === "1" ||
  process.env.USE_MOCK_RESULT?.toLowerCase() === "true";
const dumpResultToMock =
  process.env.DUMP_RESULT_TO_MOCK === "1" ||
  process.env.DUMP_RESULT_TO_MOCK?.toLowerCase() === "true";
const mockResultPath =
  process.env.MOCK_RESULT_PATH || join(process.cwd(), "mockResult.json");
const skipCleanUpFriend =
  process.env.SKIP_CLEANUP_FRIEND === "1" ||
  process.env.SKIP_CLEANUP_FRIEND?.toLowerCase() === "true";
const heartbeatIntervalMs = Number(
  process.env.JOB_HEARTBEAT_INTERVAL_MS ?? 20_000
);
const maxProcessJobsRaw = Number(process.env.MAX_PROCESS_JOBS);
const maxProcessJobs =
  Number.isFinite(maxProcessJobsRaw) && maxProcessJobsRaw > 0
    ? Math.floor(maxProcessJobsRaw)
    : 4;

async function dumpFriendVsHtmlIfEnabled(
  html: string,
  meta: { type: number; diff: number }
) {
  if (process.env.DUMP_FRIEND_VS_HTML !== "1") return;

  try {
    const dir =
      process.env.FRIEND_VS_HTML_DIR || join(process.cwd(), "debug-html");
    if (!friendVsDumpReady) {
      friendVsDumpReady = (async () => {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
      })();
    }
    await friendVsDumpReady;

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `friend-vs-${ts}-type${meta.type}-diff${
      meta.diff
    }-${randomUUID()}.html`;
    const path = join(dir, filename);

    await writeFile(path, html, "utf8");
  } catch {
    // Best-effort debug logging; ignore failures.
  }
}

async function loadMockAggregatedResult() {
  const content = await readFile(mockResultPath, "utf8");
  const parsed = JSON.parse(content);
  return parsed.result ?? parsed;
}

export function startWorker() {
  let processingCount = 0;
  let botIndex = 0;

  const tick = async () => {
    if (processingCount >= maxProcessJobs) return;

    const availableBots = Array.from(state.cookieJars.keys());
    if (!availableBots.length) return;

    while (processingCount < maxProcessJobs) {
      const botFriendCode = availableBots[botIndex % availableBots.length];
      botIndex++;

      try {
        const job = await claimNextJob(botFriendCode);
        if (!job) {
          break;
        }

        processingCount++;
        handleJob(job)
          .catch((err) => {
            console.error("[Worker] Failed to process job:", err);
          })
          .finally(() => {
            processingCount--;
          });
      } catch (err) {
        console.error("[Worker] Failed to claim job:", err);
        break;
      }
    }
  };

  setInterval(tick, 500);
}

async function cleanUpFriend(
  cj: Awaited<ReturnType<typeof loadCookie>>,
  friendCode: string
) {
  let [sent, friends] = await Promise.all([
    getSentRequests(cj),
    getFriendList(cj),
  ]);

  const sentCodes = sent.map((s) => s.friendCode);

  if (sentCodes.includes(friendCode)) {
    console.log(
      `[Worker] Cleanup: canceling pending request for ${friendCode}`
    );
    try {
      await cancelFriendRequest(cj, friendCode);
    } catch (e) {
      sent = await getSentRequests(cj);
      if (sent.map((s) => s.friendCode).includes(friendCode)) {
        throw e;
      }
    }
  }

  if (friends.includes(friendCode)) {
    console.log(`[Worker] Cleanup: removing friend ${friendCode}`);
    try {
      await removeFriend(cj, friendCode);
    } catch (e) {
      friends = await getFriendList(cj);
      if (friends.includes(friendCode)) {
        throw e;
      }
    }
  }
}

async function handleJob(initialJob: Job) {
  let job = initialJob;
  let heartbeat: NodeJS.Timeout | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const startHeartbeat = () => {
    if (
      heartbeat ||
      !Number.isFinite(heartbeatIntervalMs) ||
      heartbeatIntervalMs <= 0
    ) {
      return;
    }
    heartbeat = setInterval(async () => {
      try {
        job = await updateJob(job.id, { updatedAt: new Date() });
      } catch (err) {
        console.warn(`[Worker] Job ${job.id}: heartbeat failed`, err);
      }
    }, heartbeatIntervalMs);
  };

  const applyPatch = async (patch: JobPatch) => {
    job = await updateJob(job.id, patch);
    return job;
  };

  const availableBots = Array.from(state.cookieJars.keys());
  if (!availableBots.length) {
    await applyPatch({
      status: "failed",
      error: "没有可用的 Bot",
    });
    return;
  }

  if (!job.botUserFriendCode || !state.cookieJars.has(job.botUserFriendCode)) {
    const selectedBot =
      availableBots[Math.floor(Math.random() * availableBots.length)];
    job = await applyPatch({
      botUserFriendCode: selectedBot,
      updatedAt: new Date(),
    });
  }

  const botFriendCode = job.botUserFriendCode!;
  const cj = await loadCookie(botFriendCode);
  if (!cj) {
    await applyPatch({
      status: "failed",
      error: `Bot ${botFriendCode} 的 Cookie 未找到`,
    });
    return;
  }

  try {
    startHeartbeat();

    const profile = await getUserProfile(cj, job.friendCode);
    if (!profile) {
      throw new Error("未找到该好友代码对应的用户，请检查好友代码是否正确!");
    }
    await applyPatch({
      profile,
      updatedAt: new Date(),
    });

    if (job.stage === "send_request") {
      console.log(`[Worker] Job ${job.id}: Checking friend list...`);
      if (!skipCleanUpFriend) {
        await cleanUpFriend(cj, job.friendCode);
      }

      console.log(`[Worker] Job ${job.id}: Checking sent requests...`);

      await sendFriendRequest(cj, job.friendCode);
      await applyPatch({ stage: "wait_acceptance", updatedAt: new Date() });

      const sentRequests = await getSentRequests(cj);
      const match = sentRequests.find((s) => s.friendCode === job.friendCode);
      if (!skipCleanUpFriend && !match) {
        throw new Error("发送好友请求失败");
      }
      await applyPatch({
        friendRequestSentAt: match?.appliedAt ?? new Date().toISOString(),
        updatedAt: new Date(),
      });
    } else if (job.stage === "wait_acceptance") {
      console.log(`[Worker] Job ${job.id}: Waiting for acceptance...`);
      const pending = await getAccpetRequests(cj);
      if (pending.includes(job.friendCode)) {
        console.log(
          `[Worker] Job ${job.id}: Friend request pending approval, accepting...`
        );
        await allowFriendRequest(cj, job.friendCode);
      }

      const friends = await getFriendList(cj);
      if (friends.includes(job.friendCode)) {
        console.log(`[Worker] Job ${job.id}: Friend accepted!`);
        await applyPatch({ stage: "update_score", updatedAt: new Date() });
      } else {
        const elapsed = Date.now() - job.createdAt.getTime();
        console.log(job.createdAt.getTime());
        if (elapsed > 1000 * 60 * 1) {
          throw new Error("等待好友接受请求超时");
        }
        await applyPatch({ updatedAt: new Date() });
      }
    } else if (job.stage === "update_score") {
      if (job.skipUpdateScore) {
        console.log(
          `[Worker] Job ${job.id}: Skipping update_score (skipUpdateScore=true).`
        );
        await applyPatch({
          status: "completed",
          error: null,
          updatedAt: new Date(),
        });

        // Clean up any friendship/request after finishing work
        // Not waiting for it to complete
        if (!skipCleanUpFriend) {
          cleanUpFriend(cj, job.friendCode);
        }
        return;
      }

      console.log(`[Worker] Job ${job.id}: Updating scores...`);
      if (useMockResult) {
        console.log(
          `[Worker] Job ${job.id}: Using mock result (MOCK_RESULT_PATH=${mockResultPath}).`
        );
        const aggregated = await loadMockAggregatedResult();
        job = await applyPatch({
          result: aggregated,
          status: "completed",
          error: null,
          updatedAt: new Date(),
        });

        // Clean up any friendship/request after finishing work
        // Not waiting for it to complete
        if (!skipCleanUpFriend) {
          cleanUpFriend(cj, job.friendCode);
        }

        const cost = job.updatedAt.getTime() - job.createdAt.getTime();
        console.log(
          `[Worker] Job ${job.id}: Completed with mock result! Cost: ${cost}ms`
        );
        return;
      }
      await favoriteOnFriend(cj, job.friendCode);

      const diffs = [0, 1, 2, 3, 4, 10];
      const tasks: Array<() => Promise<any>> = [];

      console.log(`[Worker] Job ${job.id}: Fetching scores for all diffs...`);

      for (const diff of diffs) {
        tasks.push(async () => {
          const result = await getFriendVS(cj, job.friendCode, 1, diff);
          await dumpFriendVsHtmlIfEnabled(result, { type: 1, diff });
          return { diff, type: 1, result };
        });
        tasks.push(async () => {
          const result = await getFriendVS(cj, job.friendCode, 2, diff);
          await dumpFriendVsHtmlIfEnabled(result, { type: 2, diff });
          return { diff, type: 2, result };
        });
      }

      const scores = await runWithConcurrency(tasks, 2);
      const parsedScores = scores.map((score) => ({
        diff: score.diff,
        type: score.type,
        songs: parseFriendVsSongs(score.result),
      }));

      const aggregated = aggregateSongResults(parsedScores);

      // console.log("aggregated result", aggregated);

      if (dumpResultToMock) {
        try {
          await mkdir(dirname(mockResultPath), { recursive: true });
          await writeFile(
            mockResultPath,
            JSON.stringify({ result: aggregated }, null, 2),
            "utf8"
          );
          console.log(
            `[Worker] Job ${job.id}: Dumped aggregated result to ${mockResultPath}.`
          );
        } catch (err) {
          console.warn(
            `[Worker] Job ${job.id}: Failed to dump aggregated result to ${mockResultPath}:`,
            err
          );
        }
      }

      job = await applyPatch({
        result: aggregated,
        status: "completed",
        error: null,
        updatedAt: new Date(),
      });

      // Clean up any friendship/request after finishing work
      // Not waiting for it to complete
      if (!skipCleanUpFriend) {
        cleanUpFriend(cj, job.friendCode);
      }

      const cost = job.updatedAt.getTime() - job.createdAt.getTime();
      console.log(`[Worker] Job ${job.id}: Completed! Cost: ${cost}ms`);
      return;
    }
  } catch (e: any) {
    console.error(`[Worker] Job ${job.id} failed:`, e);
    job = await applyPatch({
      status: "failed",
      error: e?.message || String(e),
      updatedAt: new Date(),
    });
  } finally {
    stopHeartbeat();
    if (job.executing) {
      try {
        await applyPatch({ executing: false });
      } catch (releaseErr) {
        console.error(
          `[Worker] Job ${job.id}: failed to release execution flag`,
          releaseErr
        );
      }
    }
  }
}

type AggregatedResult = Record<
  string,
  Partial<
    Record<
      "standard" | "dx" | "utage",
      Record<
        string,
        Record<
          number,
          {
            level: string;
            dxScore?: string | null;
            score?: string | null;
            fs?: string | null;
            fc?: string | null;
          }
        >
      >
    >
  >
>;

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  const workers = new Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(async () => {
      while (next < tasks.length) {
        const current = next++;
        results[current] = await tasks[current]();
      }
    });

  await Promise.all(workers);
  return results;
}

function aggregateSongResults(
  results: Array<{
    diff: number;
    type: number;
    songs: ReturnType<typeof parseFriendVsSongs>;
  }>
): AggregatedResult {
  const aggregated: AggregatedResult = {};

  for (const result of results) {
    for (const song of result.songs) {
      const category = song.category ?? "unknown";
      const type = song.type;
      if (!aggregated[category]) {
        aggregated[category] = {};
      }

      if (!aggregated[category][type]) {
        aggregated[category][type] = {};
      }

      const songsByType = aggregated[category][type]!;

      if (!songsByType[song.name]) {
        songsByType[song.name] = {};
      }

      if (!songsByType[song.name][result.diff]) {
        songsByType[song.name][result.diff] = {
          level: song.level,
        };
      }

      const entry = songsByType[song.name][result.diff];
      if (result.type === 1) {
        entry.dxScore = song.score ?? null;
      } else if (result.type === 2) {
        entry.score = song.score ?? null;
      }

      entry.fs = song.fs ?? null;
      entry.fc = song.fc ?? null;
    }
  }

  return aggregated;
}
