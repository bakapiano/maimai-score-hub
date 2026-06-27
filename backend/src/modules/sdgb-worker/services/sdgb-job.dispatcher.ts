import { Injectable } from '@nestjs/common';

import { SdgbJobService } from './sdgb-job.service';
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
    opts?: { timeoutMs?: number; tag?: string },
  ): Promise<ScanQrResult> {
    return this.run<ScanQrResult>('scan_qr', payload, opts);
  }

  async getRivalHash(
    payload: GetRivalHashPayload,
    opts?: { timeoutMs?: number; tag?: string },
  ): Promise<GetRivalHashResult> {
    return this.run<GetRivalHashResult>('get_rival_hash', payload, opts);
  }

  async getUserMap(
    payload: GetUserMapPayload,
    opts?: { timeoutMs?: number; tag?: string },
  ): Promise<GetUserMapResult> {
    return this.run<GetUserMapResult>('get_user_map', payload, opts);
  }

  async addRival(
    payload: AddRivalPayload,
    opts?: { timeoutMs?: number; tag?: string },
  ): Promise<AddRivalResult> {
    return this.run<AddRivalResult>('add_rival', payload, opts);
  }

  private async run<T>(
    jobType: 'scan_qr' | 'get_rival_hash' | 'get_user_map' | 'add_rival',
    payload: Record<string, unknown>,
    opts?: { timeoutMs?: number; tag?: string },
  ): Promise<T> {
    const enqueued = await this.jobs.enqueue({
      jobType,
      payload,
      requesterTag: opts?.tag ?? null,
    });
    const finished = await this.jobs.waitForCompletion(enqueued.id, {
      timeoutMs: opts?.timeoutMs,
    });
    if (!finished.result) {
      throw new Error(`sdgb job ${enqueued.id} returned no result`);
    }
    return finished.result as T;
  }
}
