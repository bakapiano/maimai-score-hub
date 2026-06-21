import { botManager, type ManagedBot } from "../common/bots/bot-manager.ts";
import {
  claimNextJob,
  updateJob,
} from "../common/backend/jobs.ts";
import { WORKER_DEFAULTS } from "../common/config.ts";
import type { Job } from "../common/types.ts";
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
  private processingCount = 0;
  private running = false;

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.claimLoop().catch((err) => {
      console.error("[Worker] Claim loop stopped unexpectedly:", err);
      this.running = false;
    });

    console.log("[Worker] Started");
  }

  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    console.log("[Worker] Stopped");
  }

  private async claimLoop(): Promise<void> {
    while (this.running) {
      if (this.processingCount >= WORKER_DEFAULTS.maxProcessJobs) {
        await sleep(500);
        continue;
      }

      const bot = botManager.getBot();
      if (!bot || bot.expired) {
        await sleep(5_000);
        continue;
      }

      try {
        const job = await claimNextJob(
          bot.friendCode,
          WORKER_DEFAULTS.jobClaimLongPollWaitMs,
        );
        if (!job) {
          continue;
        }

        const currentBot = botManager.getBot();
        if (
          !this.running ||
          this.processingCount >= WORKER_DEFAULTS.maxProcessJobs ||
          !currentBot ||
          currentBot.expired ||
          currentBot.friendCode !== bot.friendCode
        ) {
          await this.releaseJob(job);
          continue;
        }

        this.processingCount++;
        console.log(
          `[Worker] Processing job. Current count: ${this.processingCount}, Max: ${WORKER_DEFAULTS.maxProcessJobs}`,
        );
        this.handleJob(job, currentBot)
          .catch((err) => {
            console.error("[Worker] Failed to process job:", err);
          })
          .finally(() => {
            this.processingCount--;
          });
      } catch (err) {
        console.error("[Worker] Failed to claim job:", err);
        await sleep(3_000);
      }
    }
  }

  private async releaseJob(job: Job): Promise<void> {
    await updateJob(job.id, {
      executing: false,
      updatedAt: new Date(),
    });
  }

  private async handleJob(initialJob: Job, bot: ManagedBot): Promise<void> {
    let job = initialJob;

    if (job.botUserFriendCode !== bot.friendCode) {
      job = await updateJob(job.id, {
        botUserFriendCode: bot.friendCode,
        updatedAt: new Date(),
      });
    }

    const handler = new JobHandler(job, bot.client);
    await handler.execute();
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
