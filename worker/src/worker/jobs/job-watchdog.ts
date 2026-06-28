import { TIMEOUTS } from "../../common/maimai/constants.ts";
import type { JobSession } from "./job-session.ts";

const HARD_TIMEOUT_ERROR = "硬超时：处理时间超过 30 分钟";

export class JobWatchdog {
  private readonly session: JobSession;
  private hardTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  constructor(session: JobSession) {
    this.session = session;
  }

  start(): void {
    this.startedAt = Date.now();
    this.hardTimer = setTimeout(
      () => void this.onHardTimeout(),
      TIMEOUTS.jobHardTimeout,
    );
  }

  stop(): void {
    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
  }

  private async onHardTimeout(): Promise<void> {
    if (this.session.isAborted) return;
    this.session.abort();
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : -1;
    console.error(
      `[JobHandler] Job ${this.session.job.id} HARD TIMEOUT after ${elapsedMs}ms ` +
        `(limit ${TIMEOUTS.jobHardTimeout}ms), force-failing`,
    );
    try {
      await this.session.forceFail(HARD_TIMEOUT_ERROR);
    } catch (err) {
      console.warn(
        `[JobHandler] Job ${this.session.job.id}: hard-timeout PATCH failed (ignored):`,
        err,
      );
    }
  }
}
