export const DXNET_WORKER_QUEUE_PREFIX = "dxnet-worker-jobs";
export const SDGB_PROBE_QUEUE_NAME = "sdgb-worker-jobs";
export const SDGB_INTERACTIVE_QUEUE_NAME = "sdgb-worker-interactive-jobs";

/** @deprecated Use SDGB_PROBE_QUEUE_NAME or lane routing helpers instead. */
export const SDGB_WORKER_QUEUE_NAME = SDGB_PROBE_QUEUE_NAME;

export function getDxnetWorkerQueueName(botFriendCode: string): string {
  return `${DXNET_WORKER_QUEUE_PREFIX}-${botFriendCode}`;
}

export interface DxnetWorkerJobData {
  jobId: string;
}

export interface SdgbWorkerJobData {
  jobId: string;
}
