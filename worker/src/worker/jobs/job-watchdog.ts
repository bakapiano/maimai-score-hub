import { WORKER_DEFAULTS } from "../../common/config.ts";
import { TIMEOUTS } from "../../common/maimai/constants.ts";
import type { JobSession } from "./job-session.ts";

const HARD_TIMEOUT_ERROR = "硬超时：处理时间超过 30 分钟";

export class JobWatchdog {
  private readonly session: JobSession;
  private heartbeat: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  constructor(session: JobSession) {
    this.session = session;
  }

  start(): void {
    this.startedAt = Date.now();
    this.startHeartbeat();
    this.hardTimer = setTimeout(
      () => void this.onHardTimeout(),
      TIMEOUTS.jobHardTimeout,
    );
  }

  stop(): void {
    this.stopHeartbeat();
    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
  }

  private startHeartbeat(): void {
    const interval = WORKER_DEFAULTS.heartbeatIntervalMs;
    if (this.heartbeat || !Number.isFinite(interval) || interval <= 0) {
      return;
    }

    this.heartbeat = setInterval(async () => {
      try {
        await this.session.touch();
      } catch (err) {
        console.warn(
          `[JobHandler] Job ${this.session.job.id}: heartbeat failed`,
          err,
        );
      }
    }, interval);
  }

  private async onHardTimeout(): Promise<void> {
    if (this.session.isAborted) return;
    this.session.abort();
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : -1;
    console.error(
      `[JobHandler] Job ${this.session.job.id} HARD TIMEOUT after ${elapsedMs}ms ` +
        `(limit ${TIMEOUTS.jobHardTimeout}ms), force-failing`,
    );
    this.stopHeartbeat();
    try {
      await this.session.forceFail(HARD_TIMEOUT_ERROR);
    } catch (err) {
      console.warn(
        `[JobHandler] Job ${this.session.job.id}: hard-timeout PATCH failed (ignored):`,
        err,
      );
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
