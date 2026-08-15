import { totalmem } from "node:os";

import { botManager } from "../common/bots/bot-manager.ts";
import {
  ActiveExecutionRegistry,
  ShutdownRequeueError,
} from "./runtime/active-executions.ts";
import { DxnetJobProcessor } from "./runtime/job-processor.ts";
import {
  DxnetQueueFleet,
  type DxnetQueueDelivery,
} from "./runtime/queue-fleet.ts";
import { setDxnetWorkerHealthProvider } from "./runtime/health-registry.ts";
import { SharedEligibility } from "./runtime/shared-eligibility.ts";

let worker: Worker | null = null;

export function startWorker(): Worker {
  if (!worker) {
    worker = new Worker();
    worker.start();
  }
  return worker;
}

export async function stopWorker(): Promise<void> {
  const current = worker;
  worker = null;
  await current?.stop();
}

export class Worker {
  private readonly active: ActiveExecutionRegistry;
  private readonly queues: DxnetQueueFleet;
  private readonly processor: DxnetJobProcessor;
  private unsubscribeBotState: (() => void) | null = null;
  private refreshPromise: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor() {
    this.active = new ActiveExecutionRegistry();
    this.queues = new DxnetQueueFleet(
      (delivery) => this.processDelivery(delivery),
      (deliveryId) =>
        this.active.abort(deliveryId, new Error("BullMQ lock renewal failed")),
    );
    const sharedEligibility = new SharedEligibility(this.queues);
    this.processor = new DxnetJobProcessor(this.active, sharedEligibility);
  }

  start(): void {
    if (this.unsubscribeBotState) return;
    this.unsubscribeBotState = botManager.onStateChanged(() => {
      this.scheduleRefresh();
    });
    this.scheduleRefresh();
    setDxnetWorkerHealthProvider(() => this.getHealth());
    console.log("[Worker] Started routingVersion=2");
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.unsubscribeBotState?.();
    this.unsubscribeBotState = null;
    await this.queues.pauseForShutdown();

    this.active.abortWhere(
      (execution) =>
        !execution.executionRegistered || execution.lane === "background",
      () => new ShutdownRequeueError(),
    );
    await this.active.waitForDrain(
      60_000,
      (execution) =>
        execution.executionRegistered &&
        (execution.lane === "interactive" || execution.lane === "user_sync"),
    );
    this.active.abortWhere(
      () => true,
      () => new ShutdownRequeueError(),
    );
    await this.active.waitForDrain(20_000, () => true);
    await this.queues.close(true);
    await this.refreshPromise;
    setDxnetWorkerHealthProvider(null);
    console.log("[Worker] Stopped");
  }

  getHealth() {
    const snapshot = botManager.friendListSnapshots.getSnapshot();
    const rssBytes = process.memoryUsage().rss;
    return {
      workerId:
        process.env.WORKER_ID ||
        `dxnet-worker-${process.env.HOSTNAME || "unknown"}`,
      revision:
        process.env.DXNET_WORKER_REVISION ||
        process.env.DEPLOY_REVISION ||
        "dev",
      botFriendCode: this.queues.getBotFriendCode(),
      consumersReady: this.queues.getReadyQueues(),
      snapshotAgeMs: snapshot
        ? Math.max(0, Date.now() - snapshot.updatedAt.getTime())
        : null,
      rssBytes,
      rssPercent: (rssBytes / totalmem()) * 100,
    };
  }

  private processDelivery(delivery: DxnetQueueDelivery): Promise<void> {
    return this.processor.process(delivery);
  }

  private scheduleRefresh(): void {
    this.refreshPromise = this.refreshPromise
      .then(() => this.refreshQueueWorkers())
      .catch((error) => console.error("[Worker] queue refresh failed", error));
  }

  private async refreshQueueWorkers(): Promise<void> {
    if (this.stopping) return;
    const bot = botManager.getBot();
    await this.queues.syncBot(bot && !bot.expired ? bot.friendCode : null);
  }
}
