export const DXNET_WORKER_QUEUE_NAME = "dxnet-worker-jobs";
export const SDGB_WORKER_QUEUE_NAME = "sdgb-worker-jobs";

export interface DxnetWorkerJobData {
  jobId: string;
}

export interface SdgbWorkerJobData {
  jobId: string;
}
