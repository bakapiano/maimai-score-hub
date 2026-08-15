import type { Job, JobExecutionIdentity } from "../../common/types.ts";
import {
  clearExternalApiCallBuffer,
  flushExternalApiCalls,
  recordExternalApiCall,
} from "../../common/backend/api-calls.ts";
import { MaimaiClient } from "../../common/maimai/client.ts";
import { CookieExpiredError } from "../../common/maimai/infra/errors.ts";
import { JobSession } from "./job-session.ts";
import { JobWatchdog } from "./job-watchdog.ts";
import {
  executeJobByType,
  preflightJob,
  prepareJob,
  type JobPreflightResult,
} from "./handlers/index.ts";
import { runWithRequestContext } from "../../common/maimai/infra/request-runtime.ts";
import { getJobTypePriority } from "@maimai-score-hub/shared";

export class JobHandler {
  private readonly session: JobSession;
  private readonly watchdog: JobWatchdog;

  constructor(
    job: Job,
    client: MaimaiClient,
    execution: JobExecutionIdentity,
    abortController: AbortController,
  ) {
    this.session = new JobSession(job, client, execution, abortController);
    this.watchdog = new JobWatchdog(this.session);
  }

  async execute(): Promise<Job> {
    try {
      this.watchdog.start();
      const preflightResult = await this.runPreflight();
      if (preflightResult === "continue") {
        console.log(
          `[Worker] Processing v2 job ${this.session.job.id} ` +
            `bot=${this.session.job.botUserFriendCode} ` +
            `lane=${this.session.job.routing?.lane ?? "unknown"}`,
        );
        await this.runBusinessHandler();
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
    return this.session.job;
  }

  private runPreflight(): Promise<JobPreflightResult> {
    return runWithRequestContext(
      {
        requestPriority:
          this.session.job.priority ??
          getJobTypePriority(this.session.job.jobType ?? null),
        signal: this.session.signal,
        onRequestLog: (entry) =>
          recordExternalApiCall(this.session.job.id, entry, {
            botFriendCode: this.session.job.botUserFriendCode,
          }),
      },
      () => preflightJob(this.session.ctx),
    );
  }

  private async runBusinessHandler(): Promise<void> {
    try {
      await runWithRequestContext(
        {
          requestPriority:
            this.session.job.priority ??
            getJobTypePriority(this.session.job.jobType ?? null),
          signal: this.session.signal,
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
    } catch (error: unknown) {
      if (error instanceof CookieExpiredError) {
        console.warn(
          `[JobHandler] Job ${this.session.job.id}: Cookie expired, will retry later`,
        );
        return;
      }
      console.error(`[JobHandler] Job ${this.session.job.id} failed:`, error);
      await this.session.fail(
        error instanceof Error ? error.message : String(error),
        { updatedAt: new Date() },
      );
    }
  }
}
