export const DXNET_WORKER_QUEUE_PREFIX = "dxnet-worker-jobs";
export const SDGB_WORKER_QUEUE_NAME = "sdgb-worker-jobs";

export function getDxnetWorkerQueueName(botFriendCode: string): string {
  return `${DXNET_WORKER_QUEUE_PREFIX}-${botFriendCode}`;
}

export interface DxnetWorkerJobData {
  jobId: string;
}

export interface SdgbWorkerJobData {
  jobId: string;
}
