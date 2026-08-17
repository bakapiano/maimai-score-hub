export const DXNET_PINNED_QUEUE_PREFIX = "dxnet-worker";
export const DXNET_SHARED_QUEUE_PREFIX = "dxnet-shared";
export const SDGB_PROBE_QUEUE_NAME = "sdgb-worker-jobs";
export const SDGB_INTERACTIVE_QUEUE_NAME = "sdgb-worker-interactive-jobs";

export const DXNET_EXECUTION_LANES = [
  "interactive",
  "user_sync",
  "background",
] as const;

export type DxnetQueueLane = (typeof DXNET_EXECUTION_LANES)[number];

export function getDxnetSharedQueueName(lane: DxnetQueueLane): string {
  return `${DXNET_SHARED_QUEUE_PREFIX}-${lane.replace("_", "-")}-jobs`;
}

export function getDxnetPinnedQueueName(
  botFriendCode: string,
  lane: DxnetQueueLane,
): string {
  return `${DXNET_PINNED_QUEUE_PREFIX}-${botFriendCode}-${lane.replace("_", "-")}-jobs`;
}

export function getDxnetWorkerQueueNames(botFriendCode: string): string[] {
  return DXNET_EXECUTION_LANES.flatMap((lane) => [
    getDxnetSharedQueueName(lane),
    getDxnetPinnedQueueName(botFriendCode, lane),
  ]);
}

export function getDxnetDeliveryJobId(
  mongoJobId: string,
  deliveryEpoch: number,
): string {
  return `${mongoJobId}-e${deliveryEpoch}`;
}

export function parseDxnetDeliveryJobId(
  deliveryJobId: string,
): { jobId: string; deliveryEpoch: number } | null {
  const match = /^(.*)-e(\d+)$/.exec(deliveryJobId);
  if (!match) return null;
  const deliveryEpoch = Number(match[2]);
  return Number.isSafeInteger(deliveryEpoch) && deliveryEpoch >= 1
    ? { jobId: match[1], deliveryEpoch }
    : null;
}

export interface DxnetWorkerJobData {
  jobId: string;
  deliveryEpoch: number;
}

export interface SdgbWorkerJobData {
  jobId: string;
  attempt: number;
}
