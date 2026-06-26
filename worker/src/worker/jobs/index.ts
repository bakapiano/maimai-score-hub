import type { Job } from "../../common/types.ts";
import {
  clearApiLogBuffer,
  flushApiLogs,
  recordApiLog,
} from "../../common/backend/api-logs.ts";
import { MaimaiClient } from "../../common/maimai/client.ts";
import { CookieExpiredError } from "../../common/maimai/infra/errors.ts";
import { JobSession } from "./job-session.ts";
import { JobWatchdog } from "./job-watchdog.ts";
import {
  executeJobByType,
  prepareJob,
} from "./handlers/index.ts";
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
          onRequestLog: (entry) => recordApiLog(this.session.job.id, entry),
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

      await flushApiLogs(this.session.job.id).catch((err) => {
        console.warn(
          `[JobHandler] Job ${this.session.job.id}: Failed to flush API logs`,
          err,
        );
      });
      clearApiLogBuffer(this.session.job.id);

      if (!this.session.isAborted && this.session.job.executing) {
        try {
          await this.session.applyPatch({ executing: false });
        } catch (releaseErr) {
          console.error(
            `[JobHandler] Job ${this.session.job.id}: failed to release execution flag`,
            releaseErr,
          );
        }
      }
    }

    return this.session.job;
  }
}
