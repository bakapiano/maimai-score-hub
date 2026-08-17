import type { Job as BullMQJob } from "bullmq";
import { Worker as BullMQWorker } from "bullmq";
import {
  DXNET_EXECUTION_LANES,
  getDxnetPinnedQueueName,
  getDxnetSharedQueueName,
  type DxnetExecutionLane,
  type DxnetWorkerJobData,
} from "@maimai-score-hub/shared";

import {
  createBullmqWorkerOptions,
  getDxnetLaneConcurrency,
} from "../../common/bullmq.ts";

export interface DxnetQueueDelivery {
  queueName: string;
  lane: DxnetExecutionLane;
  consumerBotFriendCode: string;
  queueJob: BullMQJob<DxnetWorkerJobData, void>;
  token?: string;
}

type DeliveryProcessor = (delivery: DxnetQueueDelivery) => Promise<void>;

export interface SharedQueueControl {
  pauseShared(): Promise<void>;
  resumeShared(): Promise<void>;
}

export class DxnetQueueFleet implements SharedQueueControl {
  private readonly processDelivery: DeliveryProcessor;
  private readonly onLockRenewalFailed: (deliveryId: string) => void;
  private readonly queueWorkers = new Map<
    string,
    BullMQWorker<DxnetWorkerJobData, void>
  >();
  private readonly closingWorkers = new Set<
    BullMQWorker<DxnetWorkerJobData, void>
  >();
  private readonly readyQueues = new Set<string>();
  private botFriendCode: string | null = null;
  private stopping = false;

  constructor(
    processDelivery: DeliveryProcessor,
    onLockRenewalFailed: (deliveryId: string) => void,
  ) {
    this.processDelivery = processDelivery;
    this.onLockRenewalFailed = onLockRenewalFailed;
  }

  async syncBot(nextBotFriendCode: string | null): Promise<void> {
    if (this.stopping) return;
    if (
      nextBotFriendCode === this.botFriendCode &&
      this.queueWorkers.size > 0
    ) {
      return;
    }

    await this.closeQueueWorkers();
    if (this.stopping) return;
    if (!nextBotFriendCode) {
      console.log("[Worker] Waiting for a valid bot before starting BullMQ");
      return;
    }

    this.botFriendCode = nextBotFriendCode;
    for (const lane of DXNET_EXECUTION_LANES) {
      const concurrency = getDxnetLaneConcurrency(lane);
      this.createQueueWorker(
        getDxnetSharedQueueName(lane),
        lane,
        nextBotFriendCode,
        concurrency,
      );
      this.createQueueWorker(
        getDxnetPinnedQueueName(nextBotFriendCode, lane),
        lane,
        nextBotFriendCode,
        concurrency,
      );
    }
  }

  async pauseShared(): Promise<void> {
    await Promise.allSettled(
      DXNET_EXECUTION_LANES.map((lane) =>
        this.queueWorkers.get(getDxnetSharedQueueName(lane))?.pause(true),
      ),
    );
  }

  async resumeShared(): Promise<void> {
    if (this.stopping) return;
    await Promise.allSettled(
      DXNET_EXECUTION_LANES.map((lane) =>
        this.queueWorkers.get(getDxnetSharedQueueName(lane))?.resume(),
      ),
    );
  }

  async pauseForShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(
      [...this.queueWorkers.values()].map((worker) => worker.pause(true)),
    );
  }

  async close(force = false): Promise<void> {
    this.stopping = true;
    const alreadyClosing = [...this.closingWorkers];
    await Promise.allSettled([
      this.closeQueueWorkers(force),
      ...alreadyClosing.map((worker) => worker.close(force)),
    ]);
  }

  getBotFriendCode(): string | null {
    return this.botFriendCode;
  }

  getReadyQueues(): string[] {
    return [...this.readyQueues];
  }

  private createQueueWorker(
    queueName: string,
    lane: DxnetExecutionLane,
    consumerBotFriendCode: string,
    concurrency: number,
  ): void {
    const queueWorker = new BullMQWorker<DxnetWorkerJobData, void>(
      queueName,
      (queueJob, token) =>
        this.processDelivery({
          queueName,
          lane,
          consumerBotFriendCode,
          queueJob,
          token,
        }),
      createBullmqWorkerOptions(concurrency),
    );
    queueWorker.on("ready", () => {
      if (this.queueWorkers.get(queueName) !== queueWorker) return;
      this.readyQueues.add(queueName);
      console.log(
        `[Worker] BullMQ worker ready queue=${queueName} concurrency=${concurrency}`,
      );
    });
    queueWorker.on("lockRenewalFailed", (jobIds) => {
      for (const jobId of jobIds) {
        this.onLockRenewalFailed(jobId);
      }
    });
    queueWorker.on("error", (error) => {
      console.error(`[Worker] BullMQ error queue=${queueName}:`, error);
    });
    queueWorker.on("stalled", (jobId) => {
      console.warn(`[Worker] BullMQ stalled queue=${queueName} job=${jobId}`);
    });
    queueWorker.on("failed", (job, error) => {
      console.error(
        `[Worker] BullMQ failed queue=${queueName} job=${job?.id ?? "unknown"}:`,
        error,
      );
    });
    this.queueWorkers.set(queueName, queueWorker);
  }

  private async closeQueueWorkers(force = false): Promise<void> {
    const workers = [...this.queueWorkers.values()];
    this.queueWorkers.clear();
    this.readyQueues.clear();
    this.botFriendCode = null;
    for (const worker of workers) this.closingWorkers.add(worker);
    try {
      await Promise.allSettled(workers.map((worker) => worker.close(force)));
    } finally {
      for (const worker of workers) this.closingWorkers.delete(worker);
    }
  }
}
