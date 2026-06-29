import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AnalyticsEvent,
  ExternalApiCallEntry,
  RumEvent,
  WorkerStructuredLogEntry,
} from '@maimai-score-hub/shared';

import {
  setBackendExternalCallRecorder,
  type BackendExternalCallInput,
} from '../../../common/observability/external-call-recorder';
import { ClickHouseService } from './clickhouse.service';
import {
  getObservabilityEnvironment,
  type ObservabilityEnvironment,
} from './observability-env';

const ATTRS_MAX_BYTES = 4096;

export interface HttpRequestEvent {
  ts?: Date;
  traceId?: string;
  requestId?: string;
  service?: string;
  instance?: string;
  method: string;
  routeTemplate: string;
  statusCode: number;
  durationMs: number;
  requestBytes?: number | null;
  responseBytes?: number | null;
  friendCode?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  errorClass?: string | null;
  attrs?: Record<string, unknown>;
}

export interface JobTimelineEvent {
  ts?: Date;
  jobId: string;
  jobKind: 'dxnet' | 'sdgb';
  jobType: string;
  eventName: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
  workerId?: string | null;
  botFriendCode?: string | null;
  durationMs?: number | null;
  errorClass?: string | null;
  message?: string | null;
  attrs?: Record<string, unknown>;
}

@Injectable()
export class ObservabilityIngestService {
  private readonly environment: ObservabilityEnvironment;
  private readonly instance: string;

  constructor(
    private readonly clickhouse: ClickHouseService,
    config: ConfigService,
  ) {
    this.environment = getObservabilityEnvironment(config);
    this.instance =
      config.get<string>('OBSERVABILITY_INSTANCE') ||
      config.get<string>('HOSTNAME') ||
      process.env.COMPUTERNAME ||
      'backend';
    setBackendExternalCallRecorder((input) =>
      this.recordBackendExternalApiCall(input),
    );
  }

  recordHttpRequest(event: HttpRequestEvent): void {
    this.clickhouse.insert('http_requests', [
      {
        ts: toClickHouseTs(event.ts),
        traceId: event.traceId ?? '',
        requestId: event.requestId ?? '',
        environment: this.environment,
        service: event.service ?? 'backend',
        instance: event.instance ?? this.instance,
        method: event.method.toUpperCase(),
        routeTemplate: sanitizeDimension(event.routeTemplate, 512),
        statusCode: toUInt(event.statusCode),
        statusClass: statusClass(event.statusCode),
        durationMs: toUInt(event.durationMs),
        requestBytes: toUInt(event.requestBytes),
        responseBytes: toUInt(event.responseBytes),
        friendCode: event.friendCode ?? '',
        ipHash: event.ipHash ?? '',
        userAgentHash: event.userAgentHash ?? '',
        errorClass: event.errorClass ?? '',
        attrs: normalizeAttrs(event.attrs),
      },
    ]);
  }

  recordFrontendRum(events: RumEvent[]): { accepted: number } {
    const rows = events.map((event) => ({
      ts: toClickHouseTs(event.ts),
      environment: this.environment,
      sessionId: event.sessionId ?? '',
      friendCode: event.friendCode ?? '',
      routeTemplate: sanitizeDimension(event.routeTemplate, 512),
      pageUrlHash: event.pageUrlHash ?? '',
      referrerHash: event.referrerHash ?? '',
      browser: sanitizeDimension(event.browser ?? '', 128),
      os: sanitizeDimension(event.os ?? '', 128),
      deviceType: sanitizeDimension(event.deviceType ?? '', 64),
      fcpMs: toUInt(event.fcpMs),
      lcpMs: toUInt(event.lcpMs),
      inpMs: toUInt(event.inpMs),
      cls: Number.isFinite(event.cls) ? Number(event.cls) : 0,
      ttfbMs: toUInt(event.ttfbMs),
      loadMs: toUInt(event.loadMs),
      apiWaitMs: toUInt(event.apiWaitMs),
      jsError: event.jsError ? 1 : 0,
      errorName: sanitizeDimension(event.errorName ?? '', 128),
      errorMessageHash: event.errorMessageHash ?? '',
      traceId: event.traceId ?? '',
      attrs: normalizeAttrs(event.attrs),
    }));
    this.clickhouse.insert('frontend_rum', rows);
    return { accepted: rows.length };
  }

  recordAnalyticsEvents(events: AnalyticsEvent[]): { accepted: number } {
    const rows = events.map((event) => ({
      ts: toClickHouseTs(event.ts),
      environment: this.environment,
      eventName: sanitizeDimension(event.eventName, 128),
      friendCode: event.friendCode ?? '',
      sessionId: event.sessionId ?? '',
      routeTemplate: sanitizeDimension(event.routeTemplate ?? '', 512),
      source: sanitizeDimension(event.source ?? 'frontend', 64),
      appVersion: sanitizeDimension(event.appVersion ?? '', 128),
      properties: normalizeAttrs(event.properties),
    }));
    this.clickhouse.insert('analytics_events', rows);
    return { accepted: rows.length };
  }

  recordStructuredLogs(input: {
    service: string;
    workerKind?: string;
    workerId?: string;
    entries: WorkerStructuredLogEntry[];
  }): { accepted: number } {
    const rows = input.entries.map((entry) => ({
      ts: toClickHouseTs(entry.ts),
      environment: this.environment,
      service: sanitizeDimension(input.service, 128),
      instance: sanitizeDimension(entry.workerId ?? input.workerId ?? '', 256),
      level: normalizeLogLevel(entry.level),
      message: truncate(entry.message, 8192),
      traceId: entry.traceId ?? '',
      requestId: entry.requestId ?? '',
      jobId: entry.jobId ?? '',
      workerKind: sanitizeDimension(input.workerKind ?? '', 64),
      workerId: sanitizeDimension(entry.workerId ?? input.workerId ?? '', 256),
      botFriendCode: entry.botFriendCode ?? '',
      eventName: sanitizeDimension(entry.eventName ?? '', 128),
      errorClass: sanitizeDimension(entry.errorClass ?? '', 128),
      attrs: normalizeAttrs(entry.attrs),
    }));
    this.clickhouse.insert('structured_logs', rows);
    return { accepted: rows.length };
  }

  recordExternalApiCalls(input: {
    jobId?: string;
    workerKind?: string;
    workerId?: string;
    calls: ExternalApiCallEntry[];
  }): { accepted: number } {
    const rows = input.calls.map((call) => {
      const status = toUInt(call.statusCode);
      return {
        ts: toClickHouseTs(call.ts),
        traceId: call.traceId ?? '',
        environment: this.environment,
        jobId: call.jobId ?? input.jobId ?? '',
        workerKind: sanitizeDimension(
          call.workerKind ?? input.workerKind ?? 'dxnet',
          64,
        ),
        workerId: sanitizeDimension(call.workerId ?? input.workerId ?? '', 256),
        botFriendCode: call.botFriendCode ?? '',
        target: sanitizeDimension(call.target, 128),
        apiGroup: sanitizeDimension(call.apiGroup, 128),
        method: sanitizeDimension(call.method.toUpperCase(), 16),
        urlGroup: sanitizeDimension(call.urlGroup, 256),
        statusCode: status,
        statusClass: statusClass(status),
        durationMs: toUInt(call.durationMs),
        bodySize: toUInt(call.bodySize),
        bodyHash: call.bodyHash ?? '',
        artifactKey: call.artifactKey ?? '',
        errorClass: sanitizeDimension(call.errorClass ?? '', 128),
        attrs: normalizeAttrs(call.attrs),
      };
    });
    this.clickhouse.insert('external_api_calls', rows);
    return { accepted: rows.length };
  }

  recordBackendExternalApiCall(input: BackendExternalCallInput): void {
    this.recordExternalApiCalls({
      workerKind: 'backend',
      workerId: this.instance,
      calls: [
        {
          target: input.target,
          apiGroup: input.apiGroup,
          method: input.method,
          urlGroup: input.urlGroup,
          statusCode: input.statusCode,
          durationMs: input.durationMs,
          bodySize: input.bodySize ?? null,
          errorClass: input.errorClass,
          attrs: input.attrs,
        },
      ],
    });
  }

  recordJobTimelineEvent(event: JobTimelineEvent): void {
    this.clickhouse.insert('job_timeline_events', [
      {
        ts: toClickHouseTs(event.ts),
        environment: this.environment,
        jobId: event.jobId,
        jobKind: event.jobKind,
        jobType: sanitizeDimension(event.jobType, 128),
        eventName: sanitizeDimension(event.eventName, 128),
        fromStatus: sanitizeDimension(event.fromStatus ?? '', 64),
        toStatus: sanitizeDimension(event.toStatus ?? '', 64),
        fromStage: sanitizeDimension(event.fromStage ?? '', 64),
        toStage: sanitizeDimension(event.toStage ?? '', 64),
        workerId: sanitizeDimension(event.workerId ?? '', 256),
        botFriendCode: event.botFriendCode ?? '',
        durationMs: toUInt(event.durationMs),
        errorClass: sanitizeDimension(event.errorClass ?? '', 128),
        message: truncate(event.message ?? '', 2048),
        attrs: normalizeAttrs(event.attrs),
      },
    ]);
  }
}

function toClickHouseTs(input?: Date | string): string {
  const date =
    input instanceof Date ? input : input ? new Date(input) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(safeDate);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get(
    'minute',
  )}:${get('second')}.${safeDate.getMilliseconds().toString().padStart(3, '0')}`;
}

function statusClass(statusCode: number): string {
  if (!Number.isFinite(statusCode) || statusCode <= 0) {
    return 'unknown';
  }
  return `${Math.floor(statusCode / 100)}xx`;
}

function toUInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeLogLevel(level: unknown): string {
  if (level === 'error' || level === 'warn' || level === 'debug') {
    return level;
  }
  if (level === 'info' || level === 'log') {
    return 'info';
  }
  return 'info';
}

function sanitizeDimension(value: string, maxLength: number): string {
  return truncate(value.replace(/[\r\n\t]/g, ' ').trim(), maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizeAttrs(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const attrs: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) {
      continue;
    }
    const normalized = stringifyAttr(value);
    const nextBytes = Buffer.byteLength(key) + Buffer.byteLength(normalized);
    if (bytes + nextBytes > ATTRS_MAX_BYTES) {
      break;
    }
    attrs[key] = normalized;
    bytes += nextBytes;
  }
  return attrs;
}

function stringifyAttr(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return truncate(value, 1024);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return truncate(JSON.stringify(value), 1024);
}
