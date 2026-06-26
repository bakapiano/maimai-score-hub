import {
  DelayedError,
  Job as BullMQJob,
  WaitingError,
  Worker as BullMQWorker,
} from "bullmq";
import {
  DXNET_WORKER_QUEUE_NAME,
  type DxnetWorkerJobData,
} from "@maimai-score-hub/shared";

import { botManager, type ManagedBot } from "../common/bots/bot-manager.ts";
import { getJob, updateJob } from "../common/backend/jobs.ts";
import { createBullmqWorkerOptions } from "../common/bullmq.ts";
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

  start(): void {
    if (this.queueWorker) {
      return;
    }

    this.queueWorker = new BullMQWorker<DxnetWorkerJobData, void>(
      DXNET_WORKER_QUEUE_NAME,
      (job, token) => this.processQueueJob(job, token),
      createBullmqWorkerOptions(WORKER_DEFAULTS.maxProcessJobs),
    );

    this.queueWorker.on("ready", () => {
      console.log(
        `[Worker] BullMQ worker ready (queue=${DXNET_WORKER_QUEUE_NAME}, concurrency=${WORKER_DEFAULTS.maxProcessJobs})`,
      );
    });
    this.queueWorker.on("error", (err) => {
      console.error("[Worker] BullMQ worker error:", err);
    });
    this.queueWorker.on("stalled", (jobId) => {
      console.warn(`[Worker] BullMQ job stalled: ${jobId}`);
    });
    this.queueWorker.on("failed", (job, err) => {
      console.error(
        `[Worker] BullMQ job ${job?.id ?? "unknown"} failed:`,
        err,
      );
    });

    console.log("[Worker] Started");
  }

  stop(): void {
    if (!this.queueWorker) {
      return;
    }

    const current = this.queueWorker;
    this.queueWorker = null;
    current.close().catch((err) => {
      console.error("[Worker] Failed to close BullMQ worker:", err);
    });

    console.log("[Worker] Stopped");
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

    if (
      job.botUserFriendCode &&
      job.botUserFriendCode !== bot.friendCode
    ) {
      await this.delayQueueJob(
        queueJob,
        token,
        Date.now() + WORKER_DEFAULTS.queueRetryDelayMs,
      );
    }

    job = await this.markJobStarted(job, bot);
    console.log(
      `[Worker] Processing job ${job.id} with bot ${bot.friendCode} (stage=${job.stage})`,
    );

    const handler = new JobHandler(job, bot.client);
    const finalJob = await handler.execute();
    await this.rescheduleIfNeeded(queueJob, token, finalJob);
  }

  private async markJobStarted(job: Job, bot: ManagedBot): Promise<Job> {
    const patch: JobPatch = {
      executing: true,
      updatedAt: new Date(),
    };

    if (job.status === "queued") {
      patch.status = "processing";
    }

    if (!job.botUserFriendCode) {
      patch.botUserFriendCode = bot.friendCode;
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
