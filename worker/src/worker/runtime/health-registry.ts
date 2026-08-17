export interface DxnetWorkerRuntimeHealth {
  workerId: string;
  revision: string;
  botFriendCode: string | null;
  consumersReady: string[];
  snapshotAgeMs: number | null;
  rssBytes: number;
  rssPercent: number;
}

let provider: (() => DxnetWorkerRuntimeHealth) | null = null;

export function setDxnetWorkerHealthProvider(
  next: (() => DxnetWorkerRuntimeHealth) | null,
): void {
  provider = next;
}

export function getDxnetWorkerRuntimeHealth(): DxnetWorkerRuntimeHealth | null {
  return provider?.() ?? null;
}
