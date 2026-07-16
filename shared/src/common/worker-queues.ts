export const DXNET_WORKER_QUEUE_PREFIX = "dxnet-worker-jobs";
export const SDGB_PROBE_QUEUE_NAME = "sdgb-worker-jobs";
export const SDGB_INTERACTIVE_QUEUE_NAME = "sdgb-worker-interactive-jobs";

export function getDxnetWorkerQueueName(botFriendCode: string): string {
  return `${DXNET_WORKER_QUEUE_PREFIX}-${botFriendCode}`;
}

export interface DxnetWorkerJobData {
  jobId: string;
}

export interface SdgbWorkerJobData {
  jobId: string;
}
