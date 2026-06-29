export type BackendExternalTarget =
  | 'diving_fish'
  | 'lxns'
  | 'maimai_dxnet'
  | 'sdgb'
  | 'asset'
  | 'other';

type AttrValue = string | number | boolean | null;

export interface BackendExternalCallInput {
  target: BackendExternalTarget;
  apiGroup: string;
  method: string;
  urlGroup: string;
  statusCode: number;
  durationMs: number;
  bodySize?: number | null;
  errorClass?: string;
  attrs?: Record<string, AttrValue | AttrValue[]>;
}

type Recorder = (input: BackendExternalCallInput) => void;

let recorder: Recorder | null = null;

export function setBackendExternalCallRecorder(next: Recorder): void {
  recorder = next;
}

export function recordBackendExternalCall(
  input: BackendExternalCallInput,
): void {
  try {
    recorder?.(input);
  } catch {
    // Observability must never affect business flows.
  }
}

export async function observeFetch<T>(
  input: BackendExternalCallInput,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const statusCode = getResponseStatus(result) ?? input.statusCode;
    recordBackendExternalCall({
      ...input,
      statusCode,
      durationMs: Date.now() - startedAt,
      bodySize: getResponseBodySize(result) ?? input.bodySize,
      errorClass:
        input.errorClass || (statusCode >= 400 ? 'http_error' : undefined),
    });
    return result;
  } catch (err) {
    recordBackendExternalCall({
      ...input,
      statusCode: 0,
      durationMs: Date.now() - startedAt,
      errorClass: err instanceof Error ? err.name : 'Error',
    });
    throw err;
  }
}

function getResponseStatus(value: unknown): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const status = (value as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function getResponseBodySize(value: unknown): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const headers = (
    value as { headers?: { get?: (name: string) => string | null } }
  ).headers;
  const raw = headers?.get?.('content-length');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}
