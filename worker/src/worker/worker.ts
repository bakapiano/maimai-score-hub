import {
  DelayedError,
  Job as BullMQJob,
  WaitingError,
  Worker as BullMQWorker,
} from "bullmq";
import {
  getDxnetWorkerQueueName,
  type DxnetWorkerJobData,
} from "@maimai-score-hub/shared";

import { botManager } from "../common/bots/bot-manager.ts";
import { getJob, updateJob } from "../common/backend/jobs.ts";
import {
  createBullmqWorkerOptions,
  getDxnetWorkerConcurrency,
} from "../common/bullmq.ts";
import { WORKER_DEFAULTS } from "../common/config.ts";
import type { Job, JobPatch } from "../common/types.ts";
import { JobHandler } from "./jobs/index.ts";

let worker: Worker | null = null;

export function startWorker(): void {
  if (worker) {
    return;
  }

  worker = new Worker();
  worker.start();
}

export class Worker {
  private queueWorker: BullMQWorker<DxnetWorkerJobData, void> | null = null;
  private queueName: string | null = null;
  private unsubscribeBotState: (() => void) | null = null;

  start(): void {
    if (this.unsubscribeBotState) {
      return;
    }

    this.unsubscribeBotState = botManager.onStateChanged(() => {
      this.refreshQueueWorker();
    });
    this.refreshQueueWorker();

    console.log("[Worker] Started");
  }

  stop(): void {
    this.unsubscribeBotState?.();
    this.unsubscribeBotState = null;
    this.closeQueueWorker();

    console.log("[Worker] Stopped");
  }

  private refreshQueueWorker(): void {
    const bot = botManager.getBot();
    const nextQueueName =
      bot && !bot.expired ? getDxnetWorkerQueueName(bot.friendCode) : null;

    if (nextQueueName === this.queueName) {
      return;
    }

    this.closeQueueWorker();

    if (!nextQueueName) {
      if (bot?.expired) {
        console.warn(
          `[Worker] BullMQ worker paused: bot ${bot.friendCode} is expired`,
        );
      } else {
        console.log("[Worker] Waiting for bot cookie before starting BullMQ");
      }
      return;
    }

    this.queueName = nextQueueName;
    this.queueWorker = new BullMQWorker<DxnetWorkerJobData, void>(
      nextQueueName,
      (job, token) => this.processQueueJob(job, token),
      createBullmqWorkerOptions(),
    );

    this.queueWorker.on("ready", () => {
      console.log(
        `[Worker] BullMQ worker ready (queue=${nextQueueName}, concurrency=${getDxnetWorkerConcurrency()})`,
      );
    });
    this.queueWorker.on("error", (err) => {
      console.error("[Worker] BullMQ worker error:", err);
    });
    this.queueWorker.on("stalled", (jobId) => {
      console.warn(`[Worker] BullMQ job stalled: ${jobId}`);
    });
    this.queueWorker.on("failed", (job, err) => {
      console.error(`[Worker] BullMQ job ${job?.id ?? "unknown"} failed:`, err);
    });
  }

  private closeQueueWorker(): void {
    if (!this.queueWorker) {
      return;
    }

    const current = this.queueWorker;
    this.queueWorker = null;
    this.queueName = null;
    current.close().catch((err) => {
      console.error("[Worker] Failed to close BullMQ worker:", err);
    });
  }

  private async processQueueJob(
    queueJob: BullMQJob<DxnetWorkerJobData, void>,
    token?: string,
  ): Promise<void> {
    if (!token) {
      throw new Error("BullMQ worker token is missing");
    }

    try {
      await this.processQueueJobOnce(queueJob, token);
    } catch (err) {
      if (isBullmqControlFlow(err)) {
        throw err;
      }

      console.error(
        `[Worker] BullMQ job ${queueJob.id ?? queueJob.data.jobId} infrastructure error, retrying later:`,
        err,
      );
      await this.delayQueueJob(
        queueJob,
        token,
        Date.now() + WORKER_DEFAULTS.queueRetryDelayMs,
      );
    }
  }

  private async processQueueJobOnce(
    queueJob: BullMQJob<DxnetWorkerJobData, void>,
    token: string,
  ): Promise<void> {
    let job = await getJob(queueJob.data.jobId);
    if (isTerminal(job)) {
      return;
    }

    if (job.runAt && job.runAt.getTime() > Date.now()) {
      await this.delayQueueJob(queueJob, token, job.runAt.getTime());
    }

    const bot = botManager.getBot();
    if (!bot || bot.expired) {
      await this.delayQueueJob(
        queueJob,
        token,
        Date.now() + WORKER_DEFAULTS.queueRetryDelayMs,
      );
    }

    if (!job.botUserFriendCode) {
      await updateJob(job.id, {
        status: "failed",
        error: "DXNet job is missing botUserFriendCode",
        runAt: null,
        updatedAt: new Date(),
      });
      return;
    }

    if (job.botUserFriendCode !== bot.friendCode) {
      await updateJob(job.id, {
        status: "failed",
        error: `DXNet job routed to wrong bot queue: expected ${job.botUserFriendCode}, got ${bot.friendCode}`,
        runAt: null,
        updatedAt: new Date(),
      });
      return;
    }

    job = await this.markJobStarted(job);
    console.log(
      `[Worker] Processing job ${job.id} with bot ${bot.friendCode} (stage=${job.stage})`,
    );

    const handler = new JobHandler(job, bot.client);
    const finalJob = await handler.execute();
    await this.rescheduleIfNeeded(queueJob, token, finalJob);
  }

  private async markJobStarted(job: Job): Promise<Job> {
    const patch: JobPatch = {
      updatedAt: new Date(),
    };

    if (job.status === "queued") {
      patch.status = "processing";
    }

    if (job.runAt) {
      patch.runAt = null;
    }

    return updateJob(job.id, patch);
  }

  private async rescheduleIfNeeded(
    queueJob: BullMQJob<DxnetWorkerJobData, void>,
    token: string,
    job: Job,
  ): Promise<void> {
    if (isTerminal(job)) {
      return;
    }

    if (job.runAt && job.runAt.getTime() > Date.now()) {
      await this.delayQueueJob(queueJob, token, job.runAt.getTime());
    }

    await queueJob.moveToWait(token);
    throw new WaitingError();
  }

  private async delayQueueJob(
    queueJob: BullMQJob<DxnetWorkerJobData, void>,
    token: string,
    runAtMs: number,
  ): Promise<never> {
    await queueJob.moveToDelayed(Math.max(Date.now() + 1, runAtMs), token);
    throw new DelayedError();
  }
}

function isTerminal(job: Job): boolean {
  return ["completed", "failed", "canceled"].includes(job.status);
}

function isBullmqControlFlow(err: unknown): boolean {
  return (
    err instanceof DelayedError ||
    err instanceof WaitingError ||
    (err instanceof Error &&
      (err.name === "DelayedError" || err.name === "WaitingError"))
  );
}
