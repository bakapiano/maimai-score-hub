import type { Job } from "../../common/types.ts";
import {
  clearExternalApiCallBuffer,
  flushExternalApiCalls,
  recordExternalApiCall,
} from "../../common/backend/api-calls.ts";
import { MaimaiClient } from "../../common/maimai/client.ts";
import { CookieExpiredError } from "../../common/maimai/infra/errors.ts";
import { JobSession } from "./job-session.ts";
import { JobWatchdog } from "./job-watchdog.ts";
import { executeJobByType, prepareJob } from "./handlers/index.ts";
import { runWithRequestContext } from "../../common/maimai/infra/request-runtime.ts";
import { getJobTypePriority } from "@maimai-score-hub/shared";

export class JobHandler {
  private readonly session: JobSession;
  private readonly watchdog: JobWatchdog;

  constructor(job: Job, client: MaimaiClient) {
    this.session = new JobSession(job, client);
    this.watchdog = new JobWatchdog(this.session);
  }

  async execute(): Promise<Job> {
    try {
      this.watchdog.start();
      await runWithRequestContext(
        {
          requestPriority:
            this.session.job.priority ??
            getJobTypePriority(this.session.job.jobType ?? null),
          onRequestLog: (entry) =>
            recordExternalApiCall(this.session.job.id, entry, {
              botFriendCode: this.session.job.botUserFriendCode,
            }),
        },
        async () => {
          await prepareJob(this.session.ctx);
          await executeJobByType(this.session.ctx);
        },
      );
    } catch (e: unknown) {
      if (e instanceof CookieExpiredError) {
        console.warn(
          `[JobHandler] Job ${this.session.job.id}: Cookie expired, will retry later`,
        );
      } else {
        const error = e as Error;
        console.error(`[JobHandler] Job ${this.session.job.id} failed:`, error);
        await this.session.fail(error?.message || String(error), {
          updatedAt: new Date(),
        });
      }
    } finally {
      this.watchdog.stop();

      await flushExternalApiCalls(this.session.job.id).catch((err) => {
        console.warn(
          `[JobHandler] Job ${this.session.job.id}: Failed to flush external API calls`,
          err,
        );
      });
      clearExternalApiCallBuffer(this.session.job.id);
    }

    this.cleanupFriendAfterComplete();
    return this.session.job;
  }

  private cleanupFriendAfterComplete(): void {
    const job = this.session.job;
    if (job.status !== "completed" || !job.removeFriendAfterComplete) {
      return;
    }

    void this.session.ctx.client.friends
      .removeFriend(job.friendCode)
      .then(() => {
        console.log(
          `[JobHandler] Job ${job.id}: removed friend ${job.friendCode} after completion`,
        );
      })
      .catch((err) => {
        console.warn(
          `[JobHandler] Job ${job.id}: failed to remove friend ${job.friendCode} after completion`,
          err,
        );
      });
  }
}
