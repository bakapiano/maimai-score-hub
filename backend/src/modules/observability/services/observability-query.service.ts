import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { BotStatusEntity } from '../../bots/schemas/bot-status.schema';
import { JobEntity } from '../../job/schemas/job.schema';
import { SdgbJobEntity } from '../../sdgb-worker/schemas/sdgb-job.schema';
import { ClickHouseService } from './clickhouse.service';
import {
  parseObservabilityEnvironment,
  type ObservabilityEnvironment,
} from './observability-env';

type HistoryWindow = '24h' | '7d' | '30d';

@Injectable()
export class ObservabilityQueryService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(SdgbJobEntity.name)
    private readonly sdgbJobModel: Model<SdgbJobEntity>,
    @InjectModel(BotStatusEntity.name)
    private readonly botStatusModel: Model<BotStatusEntity>,
  ) {}

  async getStatus() {
    const [ping, status] = await Promise.all([
      this.clickhouse.ping(),
      Promise.resolve(this.clickhouse.getStatus()),
    ]);
    return { clickhouse: { ...status, ping } };
  }

  async getRealtimeOverview(environmentInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [
      clickhouseStatus,
      botTotal,
      botAvailable,
      botCabinetAvailable,
      dxnetQueue,
      sdgbQueue,
      oldestDxnetQueued,
      oldestSdgbQueued,
      recentHttpErrors,
      recentExternalErrors,
      usageToday,
    ] = await Promise.all([
      this.getStatus(),
      this.botStatusModel.countDocuments({}),
      this.botStatusModel.countDocuments({ available: true }),
      this.botStatusModel.countDocuments({
        available: true,
        cabinetUserId: { $ne: null },
      }),
      this.countDxnetQueue(),
      this.countSdgbQueue(),
      this.jobModel
        .findOne({ status: 'queued' })
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean<JobEntity>(),
      this.sdgbJobModel
        .findOne({ status: 'queued' })
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean<SdgbJobEntity>(),
      this.queryRecentHttpErrors(environment),
      this.queryRecentExternalErrors(environment),
      this.queryUsageToday(environment),
    ]);

    return {
      environment,
      generatedAt: now.toISOString(),
      system: clickhouseStatus,
      bots: {
        total: botTotal,
        available: botAvailable,
        cabinetAvailable: botCabinetAvailable,
      },
      queues: {
        dxnet: {
          ...dxnetQueue,
          oldestQueuedAgeSeconds: ageSeconds(oldestDxnetQueued?.createdAt, now),
        },
        sdgb: {
          ...sdgbQueue,
          oldestQueuedAgeSeconds: ageSeconds(oldestSdgbQueued?.createdAt, now),
        },
      },
      recentErrors: {
        http: recentHttpErrors,
        externalApi: recentExternalErrors,
      },
      usageToday,
    };
  }

  async getApiHistory(environmentInput: unknown, windowInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const interval = windowToInterval(windowInput);
    return this.clickhouse.query(
      `
      SELECT
        routeTemplate,
        method,
        count() AS requests,
        quantile(0.50)(durationMs) AS p50,
        quantile(0.95)(durationMs) AS p95,
        quantile(0.99)(durationMs) AS p99,
        countIf(statusCode >= 400) AS errors,
        countIf(statusCode >= 500) AS serverErrors,
        round(errors / requests * 100, 2) AS errorRate
      FROM http_requests
      WHERE environment = {environment:String}
        AND ts >= now() - INTERVAL ${interval}
      GROUP BY routeTemplate, method
      ORDER BY requests DESC
      LIMIT 200
      `,
      { environment },
    );
  }

  async getRumHistory(environmentInput: unknown, windowInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const interval = windowToInterval(windowInput);
    return this.clickhouse.query(
      `
      SELECT
        routeTemplate,
        count() AS samples,
        quantile(0.75)(lcpMs) AS lcpP75,
        quantile(0.95)(lcpMs) AS lcpP95,
        quantile(0.75)(inpMs) AS inpP75,
        quantile(0.95)(loadMs) AS loadP95,
        countIf(jsError = 1) AS jsErrors
      FROM frontend_rum
      WHERE environment = {environment:String}
        AND ts >= now() - INTERVAL ${interval}
      GROUP BY routeTemplate
      ORDER BY samples DESC
      LIMIT 200
      `,
      { environment },
    );
  }

  async getAnalyticsHistory(environmentInput: unknown, windowInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const interval = windowToInterval(windowInput);
    return this.clickhouse.query(
      `
      SELECT
        toDate(ts) AS day,
        eventName,
        count() AS events,
        uniqExactIf(friendCode, friendCode != '') AS users
      FROM analytics_events
      WHERE environment = {environment:String}
        AND ts >= now() - INTERVAL ${interval}
      GROUP BY day, eventName
      ORDER BY day DESC, events DESC
      LIMIT 500
      `,
      { environment },
    );
  }

  async getWorkersHistory(environmentInput: unknown, windowInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const interval = windowToInterval(windowInput);
    return this.clickhouse.query(
      `
      SELECT
        target,
        apiGroup,
        statusClass,
        errorClass,
        count() AS calls,
        quantile(0.95)(durationMs) AS p95,
        sum(bodySize) AS bodyBytes
      FROM external_api_calls
      WHERE environment = {environment:String}
        AND ts >= now() - INTERVAL ${interval}
      GROUP BY target, apiGroup, statusClass, errorClass
      ORDER BY calls DESC
      LIMIT 500
      `,
      { environment },
    );
  }

  async getStructuredLogs(input: {
    environment?: unknown;
    service?: string;
    workerKind?: string;
    workerId?: string;
    level?: string;
    jobId?: string;
    q?: string;
    sinceMinutes?: unknown;
    limit?: unknown;
  }) {
    const environment = parseObservabilityEnvironment(input.environment);
    const limit = Math.min(2000, Math.max(1, Number(input.limit) || 500));
    const sinceMinutes = clampSinceMinutes(input.sinceMinutes);
    const conditions = ['environment = {environment:String}'];
    const params: Record<string, string | number | boolean> = {
      environment,
      limit,
      sinceMinutes,
    };
    if (input.service) {
      conditions.push('service = {service:String}');
      params.service = input.service;
    }
    if (input.workerKind) {
      conditions.push('workerKind = {workerKind:String}');
      params.workerKind = input.workerKind;
    }
    if (input.workerId) {
      conditions.push('workerId = {workerId:String}');
      params.workerId = input.workerId;
    }
    if (input.level) {
      conditions.push('level = {level:String}');
      params.level = input.level;
    }
    if (input.jobId) {
      conditions.push('jobId = {jobId:String}');
      params.jobId = input.jobId;
    }
    if (input.q) {
      conditions.push('positionCaseInsensitive(message, {q:String}) > 0');
      params.q = input.q;
    }
    return this.clickhouse.query(
      `
      SELECT
        ts,
        service,
        instance,
        level,
        message,
        traceId,
        requestId,
        jobId,
        workerKind,
        workerId,
        botFriendCode,
        eventName,
        errorClass,
        attrs
      FROM structured_logs
      WHERE ${conditions.join(' AND ')}
        AND ts >= now() - toIntervalMinute({sinceMinutes:UInt32})
      ORDER BY ts DESC
      LIMIT {limit:UInt32}
      `,
      params,
    );
  }

  async getStructuredLogWorkers(input: {
    environment?: unknown;
    sinceMinutes?: unknown;
  }) {
    const environment = parseObservabilityEnvironment(input.environment);
    const sinceMinutes = clampSinceMinutes(input.sinceMinutes);
    return this.clickhouse.query(
      `
      SELECT
        workerId,
        workerKind,
        max(ts) AS lastSeenAt
      FROM structured_logs
      WHERE environment = {environment:String}
        AND ts >= now() - toIntervalMinute({sinceMinutes:UInt32})
        AND workerId != ''
      GROUP BY workerId, workerKind
      ORDER BY lastSeenAt DESC
      LIMIT 1000
      `,
      { environment, sinceMinutes },
    );
  }

  async getJobDebug(jobId: string, environmentInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const [job, sdgbJob, timeline, externalApiCalls, logs] = await Promise.all([
      this.jobModel.findOne({ id: jobId }).lean<JobEntity>(),
      this.sdgbJobModel.findOne({ id: jobId }).lean<SdgbJobEntity>(),
      this.clickhouse.query(
        `
        SELECT *
        FROM job_timeline_events
        WHERE environment = {environment:String}
          AND jobId = {jobId:String}
        ORDER BY ts ASC
        LIMIT 1000
        `,
        { environment, jobId },
      ),
      this.clickhouse.query(
        `
        SELECT *
        FROM external_api_calls
        WHERE environment = {environment:String}
          AND jobId = {jobId:String}
        ORDER BY ts ASC
        LIMIT 2000
        `,
        { environment, jobId },
      ),
      this.clickhouse.query(
        `
        SELECT *
        FROM structured_logs
        WHERE environment = {environment:String}
          AND jobId = {jobId:String}
        ORDER BY ts ASC
        LIMIT 2000
        `,
        { environment, jobId },
      ),
    ]);

    return {
      environment,
      job: job ?? null,
      sdgbJob: sdgbJob ?? null,
      timeline,
      externalApiCalls,
      logs,
      artifacts: externalApiCalls
        .map((row: Record<string, unknown>) => row.artifactKey)
        .filter((key): key is string => typeof key === 'string' && key !== ''),
    };
  }

  private async countDxnetQueue() {
    const statuses = ['queued', 'processing', 'failed', 'completed'];
    const pairs = await Promise.all(
      statuses.map(
        async (status) =>
          [status, await this.jobModel.countDocuments({ status })] as const,
      ),
    );
    return Object.fromEntries(pairs);
  }

  private async countSdgbQueue() {
    const statuses = ['queued', 'processing', 'failed', 'completed'];
    const pairs = await Promise.all(
      statuses.map(
        async (status) =>
          [status, await this.sdgbJobModel.countDocuments({ status })] as const,
      ),
    );
    return Object.fromEntries(pairs);
  }

  private queryRecentHttpErrors(environment: ObservabilityEnvironment) {
    return this.clickhouse.query(
      `
      SELECT routeTemplate, statusCode, count() AS count
      FROM http_requests
      WHERE environment = {environment:String}
        AND ts >= now() - INTERVAL 15 MINUTE
        AND statusCode >= 500
      GROUP BY routeTemplate, statusCode
      ORDER BY count DESC
      LIMIT 20
      `,
      { environment },
    );
  }

  private queryRecentExternalErrors(environment: ObservabilityEnvironment) {
    return this.clickhouse.query(
      `
      SELECT target, apiGroup, statusCode, errorClass, count() AS count
      FROM external_api_calls
      WHERE environment = {environment:String}
        AND ts >= now() - INTERVAL 15 MINUTE
        AND (statusCode >= 400 OR errorClass != '')
      GROUP BY target, apiGroup, statusCode, errorClass
      ORDER BY count DESC
      LIMIT 20
      `,
      { environment },
    );
  }

  private queryUsageToday(environment: ObservabilityEnvironment) {
    return this.clickhouse.query(
      `
      SELECT target, apiGroup, count() AS calls, quantile(0.95)(durationMs) AS p95
      FROM external_api_calls
      WHERE environment = {environment:String}
        AND ts >= toStartOfDay(now())
      GROUP BY target, apiGroup
      ORDER BY calls DESC
      LIMIT 100
      `,
      { environment },
    );
  }
}

function windowToInterval(input: unknown): string {
  const value: HistoryWindow =
    input === '7d' || input === '30d' ? input : '24h';
  if (value === '30d') {
    return '30 DAY';
  }
  if (value === '7d') {
    return '7 DAY';
  }
  return '1 DAY';
}

function ageSeconds(date: Date | undefined | null, now: Date): number | null {
  if (!date) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
}

function clampSinceMinutes(input: unknown): number {
  const parsed = Number(input);
  return Number.isFinite(parsed)
    ? Math.min(7 * 24 * 60, Math.max(1, Math.floor(parsed)))
    : 60;
}
