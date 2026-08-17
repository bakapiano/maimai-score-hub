import { Injectable } from '@nestjs/common';

import { SdgbJobService } from './sdgb-job.service';
import type { SdgbJobView } from './sdgb-job.view';
import type {
  AddRivalPayload,
  AddRivalResult,
  GetRivalHashPayload,
  GetRivalHashResult,
  GetUserMapPayload,
  GetUserMapResult,
  ScanQrPayload,
  ScanQrResult,
} from '@maimai-score-hub/shared';

/**
 * Sugar for backend-side producers that want to call sdgb-worker like a
 * function: enqueue + waitForCompletion in one shot. Keeps consumers
 * (CabinetService, AutoUpdateScheduler) free of the polling/error-handling
 * boilerplate.
 */
@Injectable()
export class SdgbJobDispatcher {
  constructor(private readonly jobs: SdgbJobService) {}

  async scanQr(
    payload: ScanQrPayload,
    opts?: DispatcherOptions,
  ): Promise<ScanQrResult> {
    return this.run<ScanQrResult>('scan_qr', payload, opts);
  }

  async getRivalHash(
    payload: GetRivalHashPayload,
    opts?: DispatcherOptions,
  ): Promise<GetRivalHashResult> {
    return this.run<GetRivalHashResult>('get_rival_hash', payload, opts);
  }

  async getUserMap(
    payload: GetUserMapPayload,
    opts?: DispatcherOptions,
  ): Promise<GetUserMapResult> {
    return this.run<GetUserMapResult>('get_user_map', payload, opts);
  }

  async addRival(
    payload: AddRivalPayload,
    opts?: DispatcherOptions,
  ): Promise<AddRivalResult> {
    return this.run<AddRivalResult>('add_rival', payload, opts);
  }

  async addRivalTerminal(
    payload: AddRivalPayload,
    opts: DispatcherOptions & { idempotencyKey: string },
  ): Promise<SdgbJobView> {
    const enqueued = await this.enqueueAddRival(payload, opts);
    return this.waitForTerminal(enqueued.id, opts);
  }

  async enqueueAddRival(
    payload: AddRivalPayload,
    opts: DispatcherOptions & { idempotencyKey: string },
  ): Promise<SdgbJobView> {
    return this.jobs.enqueue({
      jobType: 'add_rival',
      payload,
      requesterTag: opts.tag ?? null,
      idempotencyKey: opts.idempotencyKey,
      priority: opts.priority,
    });
  }

  async waitForTerminal(
    jobId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<SdgbJobView> {
    return this.jobs.waitForTerminal(jobId, opts);
  }

  private async run<T>(
    jobType: 'scan_qr' | 'get_rival_hash' | 'get_user_map' | 'add_rival',
    payload: Record<string, unknown>,
    opts?: DispatcherOptions,
  ): Promise<T> {
    const enqueued = await this.jobs.enqueue({
      jobType,
      payload,
      requesterTag: opts?.tag ?? null,
      idempotencyKey: opts?.idempotencyKey ?? null,
      priority: opts?.priority,
    });
    const finished = await this.jobs.waitForTerminal(enqueued.id, {
      timeoutMs: opts?.timeoutMs,
    });
    if (finished.status === 'failed') {
      throw new SdgbJobFailedError(finished);
    }
    if (!finished.result) {
      throw new Error(`sdgb job ${enqueued.id} returned no result`);
    }
    return finished.result as T;
  }
}

export interface DispatcherOptions {
  timeoutMs?: number;
  tag?: string;
  priority?: number;
  idempotencyKey?: string;
}

export class SdgbJobFailedError extends Error {
  readonly jobId: string;
  readonly outcomeUnknown: boolean;
  readonly failureClass: SdgbJobView['failureClass'];

  constructor(job: SdgbJobView) {
    super(job.error ?? `sdgb job ${job.id} failed`);
    this.name = 'SdgbJobFailedError';
    this.jobId = job.id;
    this.outcomeUnknown = job.outcomeUnknown;
    this.failureClass = job.failureClass;
  }
}
