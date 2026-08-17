import { DelayedError, WaitingError } from "bullmq";

import { botManager } from "../../common/bots/bot-manager.ts";
import {
  DxnetWorkerApiError,
  getJob,
  prepareCabinetFriendship,
  updateJob,
} from "../../common/backend/jobs.ts";
import { WORKER_DEFAULTS } from "../../common/config.ts";
import type { Job, JobExecutionIdentity } from "../../common/types.ts";
import {
  ActiveExecutionRegistry,
  type ActiveExecution,
  ShutdownRequeueError,
} from "./active-executions.ts";
import { JobHandler } from "../jobs/index.ts";
import type { DxnetQueueDelivery } from "./queue-fleet.ts";
import {
  LocalEligibilityError,
  SharedEligibility,
} from "./shared-eligibility.ts";

const WORKER_ID =
  process.env.WORKER_ID || `dxnet-worker-${process.env.HOSTNAME || "unknown"}`;

export class DxnetJobProcessor {
  private readonly active: ActiveExecutionRegistry;
  private readonly sharedEligibility: SharedEligibility;

  constructor(
    active: ActiveExecutionRegistry,
    sharedEligibility: SharedEligibility,
  ) {
    this.active = active;
    this.sharedEligibility = sharedEligibility;
  }

  async process(delivery: DxnetQueueDelivery): Promise<void> {
    const { queueName, lane, consumerBotFriendCode, queueJob, token } =
      delivery;
    if (!token) throw new Error("BullMQ worker token is missing");
    const deliveryId = String(queueJob.id ?? queueJob.data.jobId);
    const context = this.active.begin(deliveryId, lane);
    try {
      await this.processOnce(
        queueName,
        consumerBotFriendCode,
        queueJob,
        token,
        context,
      );
    } catch (error) {
      if (isBullmqControlFlow(error)) throw error;
      if (error instanceof ShutdownRequeueError) {
        await requeue(queueJob, token);
      }
      if (context.controller.signal.aborted) {
        throw abortError(context.controller.signal);
      }
      if (error instanceof LocalEligibilityError) {
        await delayQueueJob(queueJob, token, Date.now() + retryJitter());
      }
      if (error instanceof DxnetWorkerApiError) {
        if (error.code === "stale_execution" || error.code === "job_terminal") {
          return;
        }
        if (
          error.code === "bot_ineligible" ||
          error.code === "bot_assignment_busy"
        ) {
          await delayQueueJob(queueJob, token, Date.now() + retryJitter());
        }
        if (error.code === "invalid_route") throw error;
      }
      console.error(
        `[Worker] BullMQ job ${deliveryId} infrastructure error; retrying:`,
        error,
      );
      await delayQueueJob(
        queueJob,
        token,
        Date.now() + WORKER_DEFAULTS.queueRetryDelayMs,
      );
    } finally {
      this.active.end(context);
    }
  }

  private async processOnce(
    queueName: string,
    consumerBotFriendCode: string,
    queueJob: DxnetQueueDelivery["queueJob"],
    token: string,
    active: ActiveExecution,
  ): Promise<void> {
    let job = await getJob(queueJob.data.jobId);
    if (isTerminal(job)) return;
    if (job.runAt && job.runAt.getTime() > Date.now()) {
      await delayQueueJob(queueJob, token, job.runAt.getTime());
    }
    const bot = botManager.getBot();
    if (!bot || bot.expired) {
      await delayQueueJob(queueJob, token, Date.now() + retryJitter());
    }
    if (bot.friendCode !== consumerBotFriendCode) {
      await delayQueueJob(queueJob, token, Date.now() + retryJitter());
    }

    if (!job.routing || job.routing.version !== 2) {
      throw new Error(`DXNet job ${job.id} is missing routing v2 metadata`);
    }
    if (
      queueJob.data.deliveryEpoch !== job.routing.deliveryEpoch ||
      queueJob.data.deliveryEpoch === undefined
    ) {
      return;
    }
    active.lane = job.routing.lane;
    try {
      if (requiresSharedEligibility(job, bot.friendCode)) {
        await this.sharedEligibility.ensureEligible(
          job,
          active.controller.signal,
        );
      }
      const execution: JobExecutionIdentity = {
        deliveryEpoch: job.routing.deliveryEpoch,
        attemptsStarted: Math.max(1, queueJob.attemptsStarted ?? 1),
        queueName,
        workerId: WORKER_ID,
      };
      job = await updateJob(
        job.id,
        {
          status: "processing",
          botUserFriendCode: bot.friendCode,
          runAt: null,
          updatedAt: new Date(),
        },
        active.controller.signal,
        execution,
      );
      active.executionRegistered = true;
      if (
        job.cabinetFriendshipStatus === "pending" ||
        job.cabinetFriendshipStatus === "running"
      ) {
        const prepared = await prepareCabinetFriendship(
          job.id,
          execution,
          active.controller.signal,
        );
        job.cabinetFriendshipStatus = prepared.status;
      }
      if (job.cabinetFriendshipStatus === "failed") return;

      const handler = new JobHandler(
        job,
        bot.client,
        execution,
        active.controller,
      );
      const finalJob = await handler.execute();
      await rescheduleIfNeeded(queueJob, token, finalJob);
    } finally {
      active.executionRegistered = false;
    }
  }
}

function isTerminal(job: Job): boolean {
  return ["completed", "failed", "canceled"].includes(job.status);
}

function requiresSharedEligibility(job: Job, botFriendCode: string): boolean {
  const friendshipStatus = job.cabinetFriendshipStatus;
  return (
    job.routing?.deliveryMode === "shared" &&
    friendshipStatus !== undefined &&
    friendshipStatus !== "not_required" &&
    (job.botUserFriendCode !== botFriendCode ||
      !["running", "ready", "uncertain"].includes(friendshipStatus))
  );
}

async function rescheduleIfNeeded(
  queueJob: DxnetQueueDelivery["queueJob"],
  token: string,
  job: Job,
): Promise<void> {
  if (isTerminal(job)) return;
  if (
    job.routing?.version === 2 &&
    queueJob.data.deliveryEpoch !== job.routing.deliveryEpoch
  ) {
    return;
  }
  if (job.runAt && job.runAt.getTime() > Date.now()) {
    await delayQueueJob(queueJob, token, job.runAt.getTime());
  }
  await requeue(queueJob, token);
}

async function requeue(
  queueJob: DxnetQueueDelivery["queueJob"],
  token: string,
): Promise<never> {
  await queueJob.moveToWait(token);
  throw new WaitingError();
}

async function delayQueueJob(
  queueJob: DxnetQueueDelivery["queueJob"],
  token: string,
  runAtMs: number,
): Promise<never> {
  await queueJob.moveToDelayed(Math.max(Date.now() + 1, runAtMs), token);
  throw new DelayedError();
}

function retryJitter(): number {
  return 5_000 + Math.floor(Math.random() * 5_001);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("job aborted");
}

function isBullmqControlFlow(error: unknown): boolean {
  return (
    error instanceof DelayedError ||
    error instanceof WaitingError ||
    (error instanceof Error &&
      (error.name === "DelayedError" || error.name === "WaitingError"))
  );
}
