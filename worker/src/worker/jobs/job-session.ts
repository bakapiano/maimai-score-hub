import type { Job, JobPatch, JobStage } from "../../common/types.ts";

import type { MaimaiClient } from "../../common/maimai/client.ts";
import type { JobExecutionContext } from "./handlers/index.ts";
import { updateJob } from "../../common/backend/jobs.ts";

const PATCH_BACKOFF_MS = [0, 1_000, 3_000] as const;
const TRANSIENT_PATCH_ERROR =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|timed out|HTTP 5\d\d|Status: 5\d\d/;

export class JobSession {
  readonly ctx: JobExecutionContext;
  private aborted = false;

  constructor(job: Job, client: MaimaiClient) {
    this.ctx = {
      job,
      client,
      applyPatch: (patch) => this.applyPatch(patch),
      transitionTo: (stage, patch) => this.transitionTo(stage, patch),
      delay: (ms, patch) => this.delay(ms, patch),
      fail: (error, patch) => this.fail(error, patch),
      completeJob: () => this.completeJob(),
      sleep: (ms) => this.sleep(ms),
    };
  }

  get job(): Job {
    return this.ctx.job;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  abort(): void {
    this.aborted = true;
  }

  async completeJob(): Promise<void> {
    await this.applyPatch({
      status: "completed",
      error: null,
      runAt: null,
      updatedAt: new Date(),
    });
  }

  async transitionTo(stage: JobStage, patch: JobPatch = {}): Promise<Job> {
    return this.applyPatch({
      ...patch,
      stage,
      runAt: patch.runAt ?? null,
      updatedAt: patch.updatedAt ?? new Date(),
    });
  }

  async delay(ms: number, patch: JobPatch = {}): Promise<Job> {
    return this.applyPatch({
      ...patch,
      runAt: new Date(Date.now() + ms),
      updatedAt: patch.updatedAt ?? new Date(),
    });
  }

  async fail(error: string, patch: JobPatch = {}): Promise<Job> {
    return this.applyPatch({
      ...patch,
      status: "failed",
      error,
      runAt: null,
      updatedAt: patch.updatedAt ?? new Date(),
    });
  }

  async applyPatch(patch: JobPatch): Promise<Job> {
    if (this.aborted) {
      throw new Error("job aborted by hard timeout");
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < PATCH_BACKOFF_MS.length; attempt++) {
      const backoffMs = PATCH_BACKOFF_MS[attempt];
      if (backoffMs > 0) {
        await this.sleep(backoffMs);
      }

      try {
        this.ctx.job = await updateJob(this.ctx.job.id, patch);
        return this.ctx.job;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!TRANSIENT_PATCH_ERROR.test(msg)) {
          throw err;
        }
        console.warn(
          `[JobHandler] Job ${this.ctx.job.id} applyPatch attempt ${attempt + 1}/${PATCH_BACKOFF_MS.length} failed: ${msg}; will retry`,
        );
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(
          `applyPatch failed after ${PATCH_BACKOFF_MS.length} attempts`,
        );
  }

  async forceFail(error: string): Promise<void> {
    this.ctx.job = await updateJob(this.ctx.job.id, {
      status: "failed",
      error,
      runAt: null,
      updatedAt: new Date(),
    });
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
