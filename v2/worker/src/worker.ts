import type { Job, JobPatch } from "./job-service-client.ts";
import { claimNextJob, updateJob } from "./job-service-client.ts";
import {
  favoriteOnFriend,
  getFriendList,
  getFriendVS,
  getSentRequests,
  sendFriendRequest,
} from "./crawler.ts";

import { CookieExpiredError } from "./util.ts";
import { loadCookie } from "./cookie.ts";
import { parseFriendVsSongs } from "./friend-vs-parser.ts";
import { state } from "./state.ts";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function dumpFriendVsHtmlIfEnabled(
  html: string,
  meta: { type: number; diff: number }
) {
  if (process.env.DUMP_FRIEND_VS_HTML !== "1") return;

  try {
    const dir =
      process.env.FRIEND_VS_HTML_DIR || join(process.cwd(), "debug-html");
    await mkdir(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `friend-vs-${ts}-type${meta.type}-diff${meta.diff}-${randomUUID()}.html`;
    const path = join(dir, filename);

    await writeFile(path, html, "utf8");
  } catch {
    // Best-effort debug logging; ignore failures.
  }
}

export function startWorker() {
  let processing = false;

  setInterval(async () => {
    if (processing) return;
    processing = true;

    try {
      const job = await claimNextJob();
      if (!job) {
        return;
      }

      await handleJob(job);
    } catch (err) {
      console.error("[Worker] Failed to process job loop:", err);
    } finally {
      processing = false;
    }
  }, 100);
}

async function handleJob(initialJob: Job) {
  let job = initialJob;

  const applyPatch = async (patch: JobPatch) => {
    job = await updateJob(job.id, patch);
    return job;
  };

  const availableBots = Array.from(state.cookieJars.keys());
  if (!availableBots.length) {
    await applyPatch({
      status: "failed",
      error: "No bots available",
      executing: false,
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
      error: `Cookie not found for bot ${botFriendCode}`,
      executing: false,
    });
    return;
  }

  try {
    if (job.stage === "send_request") {
      console.log(`[Worker] Job ${job.id}: Checking friend list...`);
      const friends = await getFriendList(cj);
      if (friends.includes(job.friendCode)) {
        console.log(`[Worker] Job ${job.id}: Already friends.`);
        await applyPatch({ stage: "update_score", updatedAt: new Date() });
        return;
      }

      console.log(`[Worker] Job ${job.id}: Checking sent requests...`);
      const sent = await getSentRequests(cj);
      if (sent.includes(job.friendCode)) {
        console.log(`[Worker] Job ${job.id}: Request already sent.`);
        await applyPatch({ stage: "wait_acceptance", updatedAt: new Date() });
      } else {
        console.log(`[Worker] Job ${job.id}: Sending friend request...`);
        await sendFriendRequest(cj, job.friendCode);
        await applyPatch({ stage: "wait_acceptance", updatedAt: new Date() });
      }
    } else if (job.stage === "wait_acceptance") {
      console.log(`[Worker] Job ${job.id}: Waiting for acceptance...`);
      const friends = await getFriendList(cj);
      if (friends.includes(job.friendCode)) {
        console.log(`[Worker] Job ${job.id}: Friend accepted!`);
        await applyPatch({ stage: "update_score", updatedAt: new Date() });
      } else {
        const elapsed = Date.now() - job.updatedAt.getTime();
        if (elapsed > 1000 * 60 * 5) {
          throw new Error("Timeout waiting for friend acceptance");
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
          retryCount: 0,
          nextRetryAt: null,
          executing: false,
          error: null,
          updatedAt: new Date(),
        });
        return;
      }

      console.log(`[Worker] Job ${job.id}: Updating scores...`);
      await favoriteOnFriend(cj, job.friendCode);

      const diffs = [0, 1, 2, 3, 4, 10];
      const promises: Promise<any>[] = [];

      console.log(`[Worker] Job ${job.id}: Fetching scores for all diffs...`);

      for (const diff of diffs) {
        promises.push(
          getFriendVS(cj, job.friendCode, 1, diff).then(async (result) => {
            await dumpFriendVsHtmlIfEnabled(result, { type: 1, diff });
            return {
              diff,
              type: 1,
              result,
            };
          })
        );
        promises.push(
          getFriendVS(cj, job.friendCode, 2, diff).then(async (result) => {
            await dumpFriendVsHtmlIfEnabled(result, { type: 2, diff });
            return {
              diff,
              type: 2,
              result,
            };
          })
        );
      }

      const scores = await Promise.all(promises);
      const parsedScores = scores.map((score) => ({
        diff: score.diff,
        type: score.type,
        songs: parseFriendVsSongs(score.result),
      }));

      const aggregated = aggregateSongResults(parsedScores);

      console.log("aggregated result", aggregated);

      job = await applyPatch({
        result: aggregated,
        status: "completed",
        retryCount: 0,
        nextRetryAt: null,
        executing: false,
        error: null,
        updatedAt: new Date(),
      });

      const cost = job.updatedAt.getTime() - job.createdAt.getTime();
      console.log(`[Worker] Job ${job.id}: Completed! Cost: ${cost}ms`);
      return;
    }
  } catch (e: any) {
    console.error(`[Worker] Job ${job.id} failed:`, e);
    const retryCount = (job.retryCount ?? 0) + 1;

    const patch: JobPatch = {
      retryCount,
      error:
        e instanceof CookieExpiredError ? e.message : e?.message || String(e),
      updatedAt: new Date(),
    };

    if (retryCount >= 5) {
      patch.status = "failed";
      patch.nextRetryAt = null;
      patch.executing = false;
      console.error(
        `[Worker] Job ${job.id}: reached max retry attempts (${retryCount}).`
      );
    } else {
      patch.status = "processing";
      const delay = Math.floor(Math.random() * 60000);
      patch.nextRetryAt = new Date(Date.now() + delay);
      patch.executing = false;
      console.warn(
        `[Worker] Job ${job.id}: retry #${retryCount} scheduled in ${delay}ms.`
      );
    }

    job = await applyPatch(patch);
  } finally {
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
      "dx" | "sd",
      Record<
        string,
        Record<
          number,
          {
            level: string;
            dxScore?: string | null;
            score?: string | null;
          }
        >
      >
    >
  >
>;

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
      const kind = song.kind;
      if (!aggregated[category]) {
        aggregated[category] = {};
      }

      if (!aggregated[category][kind]) {
        aggregated[category][kind] = {};
      }

      const songsByKind = aggregated[category][kind]!;

      if (!songsByKind[song.name]) {
        songsByKind[song.name] = {};
      }

      if (!songsByKind[song.name][result.diff]) {
        songsByKind[song.name][result.diff] = {
          level: song.level,
        };
      }

      const entry = songsByKind[song.name][result.diff];
      if (result.type === 1) {
        entry.dxScore = song.score ?? null;
      } else if (result.type === 2) {
        entry.score = song.score ?? null;
      }
    }
  }

  return aggregated;
}
