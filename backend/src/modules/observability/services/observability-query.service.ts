/* eslint-disable max-lines */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { AutoUpdateProbeStateEntity } from '../../auto-update/schemas/auto-update-probe-state.schema';
import { BotStatusEntity } from '../../bots/schemas/bot-status.schema';
import { JobEntity } from '../../job/schemas/job.schema';
import { ProberExportJobEntity } from '../../prober-export/schemas/prober-export-job.schema';
import { RedisService } from '../../../common/redis/redis.service';
import { SdgbJobEntity } from '../../sdgb-worker/schemas/sdgb-job.schema';
import { ClickHouseService } from './clickhouse.service';
import {
  parseObservabilityEnvironment,
  type ObservabilityEnvironment,
} from './observability-env';

type HistoryWindow = '24h' | '7d' | '30d';
type WorkerKind = 'dxnet' | 'sdgb' | 'prober_export';
type RealtimeWorkerWindow = '15m' | '1h' | '6h' | '24h';
type AutoUpdateWindow = '6h' | '24h' | '7d';
type AutoUpdateProject = 'fcfs' | 'settled' | 'daily';

type TerminalJob = {
  jobType: string;
  status: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  durationMs: number;
};

type QueueRow = {
  jobType: string;
  queued: number;
  processing: number;
  delayed: number;
  failed: number;
  completed: number;
  oldestQueuedAgeSeconds: number | null;
};

type ActiveWorkerJob = {
  id: string;
  jobType: string;
  status: string;
  stage: string | null;
  workerId: string | null;
  botFriendCode: string | null;
  friendCode: string | null;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
};

type WorkerGroup = {
  workerKind: WorkerKind;
  title: string;
  workers: Array<Record<string, unknown>>;
  queueByJobType: QueueRow[];
  activeJobs: ActiveWorkerJob[];
  successRateTrend: Array<{
    bucket: string;
    jobType: string;
    completed: number;
    failed: number;
    total: number;
    successRate: number;
  }>;
  durationTrend: Array<{
    bucket: string;
    jobType: string;
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  }>;
  recentErrors: Array<{
    jobType: string;
    errorClass: string;
    message: string;
    count: number;
  }>;
};

type WorkerHistory = Pick<
  WorkerGroup,
  'successRateTrend' | 'durationTrend' | 'recentErrors'
>;

type ClickHouseWorkerTrendRow = {
  jobKind: string;
  bucket: string;
  jobType: string;
  completed: number | string;
  failed: number | string;
  total: number | string;
  successRate: number | string;
  avgMs: number | string;
  p50Ms: number | string;
  p95Ms: number | string;
};

type ClickHouseWorkerErrorRow = {
  jobKind: string;
  jobType: string;
  message: string;
  count: number | string;
};

type ClickHouseAutoUpdateRow = {
  project: string;
  pending: number | string;
  p50Ms: number | string;
  p95Ms: number | string;
  completePerMinute: number | string;
  drainEtaMinutes: number | string;
  recentFailures: number | string;
};

type ClickHouseAutoUpdateTrendRow = ClickHouseAutoUpdateRow & {
  bucket: string;
};

const AUTO_UPDATE_PROJECTS: Array<{
  key: AutoUpdateProject;
  label: string;
}> = [
  { key: 'fcfs', label: 'FC/FS' },
  { key: 'settled', label: 'Settled' },
  { key: 'daily', label: 'Daily' },
];

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
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly autoUpdateStateModel: Model<AutoUpdateProbeStateEntity>,
    @InjectModel(ProberExportJobEntity.name)
    private readonly proberExportJobModel: Model<ProberExportJobEntity>,
    private readonly redis: RedisService,
  ) {}

  async getStatus() {
    const [ping, status] = await Promise.all([
      this.clickhouse.ping(),
      Promise.resolve(this.clickhouse.getStatus()),
    ]);
    return { clickhouse: { ...status, ping } };
  }

  async getRealtimeOverview(
    environmentInput: unknown,
    recentMinutesInput?: unknown,
  ) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const recentMinutes = clampRecentMinutes(recentMinutesInput);
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
      this.queryRecentHttpErrors(environment, recentMinutes),
      this.queryRecentExternalErrors(environment, recentMinutes),
      this.queryUsageToday(environment),
    ]);

    return {
      environment,
      recentMinutes,
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

  async getRealtimeWorkerGroups(
    environmentInput: unknown,
    windowInput: unknown,
  ): Promise<{
    environment: ObservabilityEnvironment;
    generatedAt: string;
    window: RealtimeWorkerWindow;
    groups: WorkerGroup[];
  }> {
    const environment = parseObservabilityEnvironment(environmentInput);
    const window = parseRealtimeWorkerWindow(windowInput);
    const now = new Date();
    const since = new Date(now.getTime() - realtimeWindowMs(window));
    const bucketMs = getTrendBucketMs(window);

    const [clickhouseHistory, dxnet, sdgb, proberExport] = await Promise.all([
      this.getClickHouseWorkerHistory(environment, since, bucketMs),
      this.buildDxnetWorkerGroup(now),
      this.buildSdgbWorkerGroup(now),
      this.buildProberExportWorkerGroup(now, since, bucketMs),
    ]);

    return {
      environment,
      generatedAt: now.toISOString(),
      window,
      groups: [
        attachWorkerHistory(dxnet, clickhouseHistory.dxnet),
        attachWorkerHistory(sdgb, clickhouseHistory.sdgb),
        attachWorkerHistory(proberExport, pickWorkerHistory(proberExport)),
      ],
    };
  }

  async getAutoUpdateOverview(environmentInput: unknown, windowInput: unknown) {
    const environment = parseObservabilityEnvironment(environmentInput);
    const window = parseAutoUpdateWindow(windowInput);
    const { minutes, bucketMinutes } = autoUpdateWindowConfig(window);
    const rawRowsSql = autoUpdateRawRowsSql();
    const [enabledUsers, currentRows, trendRows] = await Promise.all([
      this.autoUpdateStateModel.countDocuments({ enabled: true }).exec(),
      this.clickhouse.query<ClickHouseAutoUpdateRow>(
        `
        SELECT
          project,
          argMax(pending, (sourcePriority, ts)) AS pending,
          argMax(p50Ms, (sourcePriority, ts)) AS p50Ms,
          argMax(p95Ms, (sourcePriority, ts)) AS p95Ms,
          argMax(completePerMinute, (sourcePriority, ts)) AS completePerMinute,
          argMax(drainEtaMinutes, (sourcePriority, ts)) AS drainEtaMinutes,
          argMax(recentFailures, (sourcePriority, ts)) AS recentFailures
        FROM (${rawRowsSql})
        GROUP BY project
        ORDER BY project ASC
        `,
        { environment, sinceMinutes: 2 * 24 * 60 },
      ),
      this.clickhouse.query<ClickHouseAutoUpdateTrendRow>(
        `
        SELECT
          formatDateTime(
            toTimeZone(
              toStartOfInterval(ts, INTERVAL ${bucketMinutes} MINUTE),
              'UTC'
            ),
            '%Y-%m-%dT%H:%i:%S.000Z'
          ) AS bucket,
          project,
          argMax(pending, (sourcePriority, ts)) AS pending,
          argMax(p50Ms, (sourcePriority, ts)) AS p50Ms,
          argMax(p95Ms, (sourcePriority, ts)) AS p95Ms,
          argMax(completePerMinute, (sourcePriority, ts)) AS completePerMinute,
          argMax(drainEtaMinutes, (sourcePriority, ts)) AS drainEtaMinutes,
          argMax(recentFailures, (sourcePriority, ts)) AS recentFailures
        FROM (${rawRowsSql})
        GROUP BY bucket, project
        ORDER BY bucket ASC, project ASC
        `,
        { environment, sinceMinutes: minutes },
      ),
    ]);

    const currentByProject = new Map(
      currentRows.map((row) => [row.project, normalizeAutoUpdateRow(row)]),
    );
    return {
      environment,
      generatedAt: new Date().toISOString(),
      window,
      enabledUsers,
      projects: AUTO_UPDATE_PROJECTS.map(({ key, label }) => ({
        project: key,
        label,
        ...(currentByProject.get(key) ?? emptyAutoUpdateMetrics()),
      })),
      trend: trendRows
        .filter((row) => isAutoUpdateProject(row.project))
        .map((row) => ({
          bucket: row.bucket,
          project: row.project,
          ...normalizeAutoUpdateRow(row),
        })),
    };
  }

  async getClickHouseWorkerHistory(
    environment: ObservabilityEnvironment,
    since: Date,
    bucketMs: number,
  ): Promise<Record<'dxnet' | 'sdgb', WorkerHistory>> {
    const bucketMinutes = bucketMs === 60_000 ? 1 : 5;
    const params = { environment, sinceMs: since.getTime() };
    const [trendRows, errorRows] = await Promise.all([
      this.clickhouse.query<ClickHouseWorkerTrendRow>(
        `
        SELECT
          jobKind,
          formatDateTime(
            toTimeZone(
              toStartOfInterval(ts, INTERVAL ${bucketMinutes} MINUTE),
              'UTC'
            ),
            '%Y-%m-%dT%H:%i:%S.000Z'
          ) AS bucket,
          jobType,
          countIf(eventName = 'completed') AS completed,
          countIf(eventName = 'failed') AS failed,
          completed + failed AS total,
          round(if(total = 0, 0, completed / total * 100), 2) AS successRate,
          round(avg(durationMs)) AS avgMs,
          round(quantile(0.50)(durationMs)) AS p50Ms,
          round(quantile(0.95)(durationMs)) AS p95Ms
        FROM job_timeline_events
        WHERE environment = {environment:String}
          AND ts >= fromUnixTimestamp64Milli({sinceMs:Int64}, 'Asia/Shanghai')
          AND jobKind IN ('dxnet', 'sdgb')
          AND eventName IN ('completed', 'failed')
        GROUP BY jobKind, bucket, jobType
        ORDER BY bucket ASC, jobType ASC
        `,
        params,
      ),
      this.clickhouse.query<ClickHouseWorkerErrorRow>(
        `
        SELECT
          jobKind,
          jobType,
          if(empty(message), 'unknown', message) AS message,
          count() AS count
        FROM job_timeline_events
        WHERE environment = {environment:String}
          AND ts >= fromUnixTimestamp64Milli({sinceMs:Int64}, 'Asia/Shanghai')
          AND jobKind IN ('dxnet', 'sdgb')
          AND eventName = 'failed'
        GROUP BY jobKind, jobType, message
        ORDER BY jobKind ASC, count DESC
        LIMIT 20 BY jobKind
        `,
        params,
      ),
    ]);

    const histories = {
      dxnet: emptyWorkerHistory(),
      sdgb: emptyWorkerHistory(),
    };
    for (const row of trendRows) {
      if (row.jobKind !== 'dxnet' && row.jobKind !== 'sdgb') {
        continue;
      }
      const history = histories[row.jobKind];
      history.successRateTrend.push({
        bucket: row.bucket,
        jobType: row.jobType,
        completed: numericValue(row.completed),
        failed: numericValue(row.failed),
        total: numericValue(row.total),
        successRate: numericValue(row.successRate),
      });
      history.durationTrend.push({
        bucket: row.bucket,
        jobType: row.jobType,
        avgMs: numericValue(row.avgMs),
        p50Ms: numericValue(row.p50Ms),
        p95Ms: numericValue(row.p95Ms),
      });
    }
    for (const row of errorRows) {
      if (row.jobKind !== 'dxnet' && row.jobKind !== 'sdgb') {
        continue;
      }
      const message = row.message || 'unknown';
      histories[row.jobKind].recentErrors.push({
        jobType: row.jobType,
        errorClass: classifyError(message),
        message,
        count: numericValue(row.count),
      });
    }
    return histories;
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

  private queryRecentHttpErrors(
    environment: ObservabilityEnvironment,
    recentMinutes: number,
  ) {
    return this.clickhouse.query(
      `
      SELECT routeTemplate, statusCode, count() AS count
      FROM http_requests
      WHERE environment = {environment:String}
        AND ts >= now() - toIntervalMinute({recentMinutes:UInt32})
        AND statusCode >= 500
      GROUP BY routeTemplate, statusCode
      ORDER BY count DESC
      LIMIT 20
      `,
      { environment, recentMinutes },
    );
  }

  private queryRecentExternalErrors(
    environment: ObservabilityEnvironment,
    recentMinutes: number,
  ) {
    return this.clickhouse.query(
      `
      SELECT target, apiGroup, statusCode, errorClass, count() AS count
      FROM external_api_calls
      WHERE environment = {environment:String}
        AND ts >= now() - toIntervalMinute({recentMinutes:UInt32})
        AND (statusCode >= 400 OR errorClass != '')
      GROUP BY target, apiGroup, statusCode, errorClass
      ORDER BY count DESC
      LIMIT 20
      `,
      { environment, recentMinutes },
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

  private async buildDxnetWorkerGroup(now: Date): Promise<WorkerGroup> {
    const [bots, queueByJobType, activeJobs] = await Promise.all([
      this.botStatusModel
        .find()
        .sort({ available: -1, lastReportedAt: -1 })
        .lean<BotStatusEntity[]>(),
      this.getQueueByJobType({
        model: this.jobModel,
        typeField: 'jobType',
        statuses: ['queued', 'processing'],
        now,
      }),
      this.jobModel
        .find({ status: { $in: ['queued', 'processing'] } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean<JobEntity[]>(),
    ]);

    return {
      workerKind: 'dxnet',
      title: 'DXNet Worker',
      workers: bots.map((bot) => ({
        workerId: bot.friendCode,
        botFriendCode: bot.friendCode,
        remark: bot.remark ?? null,
        available: bot.available,
        lastSeenAt: bot.lastReportedAt?.toISOString?.() ?? null,
        friendCount: bot.friendCount ?? null,
        cabinetUserId: bot.cabinetUserId ?? null,
      })),
      queueByJobType,
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        stage: job.stage,
        workerId: job.botUserFriendCode,
        botFriendCode: job.botUserFriendCode,
        friendCode: job.friendCode,
        durationMs: now.getTime() - job.createdAt.getTime(),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      })),
      ...emptyWorkerHistory(),
    };
  }

  private async buildSdgbWorkerGroup(now: Date): Promise<WorkerGroup> {
    const [workers, queueByJobType, activeJobs] = await Promise.all([
      this.getSdgbWorkerStatuses(),
      this.getQueueByJobType({
        model: this.sdgbJobModel,
        typeField: 'jobType',
        statuses: ['queued', 'processing'],
        now,
      }),
      this.sdgbJobModel
        .find({ status: { $in: ['queued', 'processing'] } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean<SdgbJobEntity[]>(),
    ]);

    return {
      workerKind: 'sdgb',
      title: 'SDGB Worker',
      workers,
      queueByJobType,
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        stage: null,
        workerId: null,
        botFriendCode: null,
        friendCode: null,
        durationMs: now.getTime() - (job.claimedAt ?? job.createdAt).getTime(),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      })),
      ...emptyWorkerHistory(),
    };
  }

  private async buildProberExportWorkerGroup(
    now: Date,
    since: Date,
    bucketMs: number,
  ): Promise<WorkerGroup> {
    // Compatibility bridge while prober_export timeline events accumulate a
    // complete 24-hour window in ClickHouse.
    const [queueByJobType, activeJobs, terminalJobs] = await Promise.all([
      this.getQueueByJobType({
        model: this.proberExportJobModel,
        typeField: 'trigger',
        statuses: ['queued', 'processing'],
        now,
      }),
      this.proberExportJobModel
        .find({ status: { $in: ['queued', 'processing'] } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean<ProberExportJobEntity[]>(),
      this.proberExportJobModel
        .find({
          status: { $in: ['completed', 'failed', 'partial_failed', 'skipped'] },
          updatedAt: { $gte: since },
        })
        .select('trigger status error createdAt updatedAt completedAt')
        .lean<ProberExportJobEntity[]>(),
    ]);

    const normalizedTerminalJobs: TerminalJob[] = terminalJobs.map((job) => ({
      jobType: job.trigger,
      status: job.status,
      error: job.error ?? null,
      createdAt: job.createdAt,
      updatedAt: job.completedAt ?? job.updatedAt,
      durationMs: Math.max(
        0,
        (job.completedAt ?? job.updatedAt).getTime() - job.createdAt.getTime(),
      ),
    }));

    return {
      workerKind: 'prober_export',
      title: '查分器导出 Worker',
      workers: [
        {
          workerId: 'prober-export-worker',
          alive: true,
          lastSeenAt: now.toISOString(),
          concurrency: Number(process.env.PROBER_EXPORT_CONCURRENCY ?? 1),
        },
      ],
      queueByJobType,
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        jobType: job.trigger,
        status: job.status,
        stage: job.targets.join(','),
        workerId: 'prober-export-worker',
        botFriendCode: null,
        friendCode: job.friendCode,
        durationMs: now.getTime() - (job.claimedAt ?? job.createdAt).getTime(),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      })),
      successRateTrend: buildSuccessRateTrend(
        normalizedTerminalJobs,
        since,
        bucketMs,
        (status) => status === 'completed' || status === 'skipped',
        (status) => status === 'failed' || status === 'partial_failed',
      ),
      durationTrend: buildDurationTrend(
        normalizedTerminalJobs,
        since,
        bucketMs,
      ),
      recentErrors: buildRecentErrors(normalizedTerminalJobs),
    };
  }

  private async getQueueByJobType(input: {
    model: Model<any>;
    typeField: string;
    statuses: string[];
    now: Date;
  }): Promise<QueueRow[]> {
    const [counts, oldestQueuedRows] = await Promise.all([
      input.model
        .aggregate<{
          _id: { jobType: string; status: string };
          count: number;
        }>([
          { $match: { status: { $in: input.statuses } } },
          {
            $group: {
              _id: {
                jobType: `$${input.typeField}`,
                status: '$status',
              },
              count: { $sum: 1 },
            },
          },
        ])
        .exec(),
      input.model
        .aggregate<{
          _id: string;
          oldestQueuedAt: Date;
        }>([
          { $match: { status: 'queued' } },
          {
            $group: {
              _id: `$${input.typeField}`,
              oldestQueuedAt: { $min: '$createdAt' },
            },
          },
        ])
        .exec(),
    ]);

    const rows = new Map<string, QueueRow>();
    const ensure = (jobType: string): QueueRow => {
      const key = jobType || 'unknown';
      const existing = rows.get(key);
      if (existing) {
        return existing;
      }
      const next: QueueRow = {
        jobType: key,
        queued: 0,
        processing: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
        oldestQueuedAgeSeconds: null,
      };
      rows.set(key, next);
      return next;
    };

    for (const count of counts) {
      const row = ensure(count._id.jobType);
      if (count._id.status in row) {
        (row as unknown as Record<string, number>)[count._id.status] =
          count.count;
      }
    }

    for (const oldest of oldestQueuedRows) {
      const row = ensure(oldest._id);
      row.oldestQueuedAgeSeconds = ageSeconds(oldest.oldestQueuedAt, input.now);
    }

    return [...rows.values()].sort((a, b) =>
      a.jobType.localeCompare(b.jobType),
    );
  }

  private async getSdgbWorkerStatuses(): Promise<
    Array<Record<string, unknown>>
  > {
    const prefix = this.redis.key('sdgb:workers:');
    const keys = await this.redis.keys(prefix + '*');
    const rows: Array<Record<string, unknown>> = [];
    for (const key of keys) {
      if (key.slice(prefix.length).includes(':')) {
        continue;
      }
      const status = await this.redis.getJson<{
        workerId?: string;
        workerClass?: string;
        capabilities?: string[];
        laneMemberships?: unknown[];
        upstreamHealth?: string;
        breakerState?: string;
        lastSeenAt?: string;
        jobsClaimed?: number;
      }>(key);
      if (status?.workerId) {
        rows.push({
          workerId: status.workerId,
          workerClass: status.workerClass ?? null,
          capabilities: status.capabilities ?? [],
          laneMemberships: status.laneMemberships ?? [],
          upstreamHealth: status.upstreamHealth ?? null,
          breakerState: status.breakerState ?? null,
          lastSeenAt: status.lastSeenAt ?? null,
          jobsClaimed: status.jobsClaimed ?? 0,
        });
      }
    }
    return rows.sort((a, b) =>
      getStringField(b, 'lastSeenAt').localeCompare(
        getStringField(a, 'lastSeenAt'),
      ),
    );
  }
}

function emptyWorkerHistory(): WorkerHistory {
  return {
    successRateTrend: [],
    durationTrend: [],
    recentErrors: [],
  };
}

function pickWorkerHistory(group: WorkerGroup): WorkerHistory {
  return {
    successRateTrend: group.successRateTrend,
    durationTrend: group.durationTrend,
    recentErrors: group.recentErrors,
  };
}

function attachWorkerHistory(
  group: WorkerGroup,
  history: WorkerHistory,
): WorkerGroup {
  const queueRows = new Map(
    group.queueByJobType.map((row) => [row.jobType, { ...row }]),
  );
  for (const trend of history.successRateTrend) {
    const row = queueRows.get(trend.jobType) ?? {
      jobType: trend.jobType,
      queued: 0,
      processing: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      oldestQueuedAgeSeconds: null,
    };
    row.completed += trend.completed;
    row.failed += trend.failed;
    queueRows.set(trend.jobType, row);
  }
  return {
    ...group,
    queueByJobType: [...queueRows.values()].sort((a, b) =>
      a.jobType.localeCompare(b.jobType),
    ),
    ...history,
  };
}

function numericValue(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getStringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
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

function parseRealtimeWorkerWindow(input: unknown): RealtimeWorkerWindow {
  if (input === '15m' || input === '6h' || input === '24h') {
    return input;
  }
  return '1h';
}

function realtimeWindowMs(window: RealtimeWorkerWindow): number {
  if (window === '24h') {
    return 24 * 60 * 60 * 1000;
  }
  if (window === '6h') {
    return 6 * 60 * 60 * 1000;
  }
  if (window === '15m') {
    return 15 * 60 * 1000;
  }
  return 60 * 60 * 1000;
}

function getTrendBucketMs(window: RealtimeWorkerWindow): number {
  if (window === '24h') {
    return 60 * 60 * 1000;
  }
  if (window === '6h') {
    return 15 * 60 * 1000;
  }
  if (window === '15m') {
    return 60 * 1000;
  }
  return 5 * 60 * 1000;
}

function isFailureStatus(status: string): boolean {
  return status === 'failed';
}

function buildSuccessRateTrend(
  jobs: TerminalJob[],
  since: Date,
  bucketMs: number,
  isSuccess: (status: string) => boolean,
  isFailure: (status: string) => boolean,
) {
  const buckets = new Map<
    string,
    {
      bucket: string;
      jobType: string;
      completed: number;
      failed: number;
      total: number;
      successRate: number;
    }
  >();

  for (const job of jobs) {
    if (!isSuccess(job.status) && !isFailure(job.status)) {
      continue;
    }
    const bucket = bucketIso(job.updatedAt, since, bucketMs);
    const key = `${bucket}:${job.jobType}`;
    const row = buckets.get(key) ?? {
      bucket,
      jobType: job.jobType,
      completed: 0,
      failed: 0,
      total: 0,
      successRate: 0,
    };
    if (isSuccess(job.status)) {
      row.completed++;
    }
    if (isFailure(job.status)) {
      row.failed++;
    }
    row.total++;
    row.successRate =
      row.total > 0 ? Math.round((row.completed / row.total) * 10000) / 100 : 0;
    buckets.set(key, row);
  }

  return [...buckets.values()].sort(
    (a, b) =>
      a.bucket.localeCompare(b.bucket) || a.jobType.localeCompare(b.jobType),
  );
}

function buildDurationTrend(
  jobs: TerminalJob[],
  since: Date,
  bucketMs: number,
) {
  const buckets = new Map<
    string,
    { bucket: string; jobType: string; values: number[] }
  >();
  for (const job of jobs) {
    const bucket = bucketIso(job.updatedAt, since, bucketMs);
    const key = `${bucket}:${job.jobType}`;
    const row = buckets.get(key) ?? {
      bucket,
      jobType: job.jobType,
      values: [],
    };
    row.values.push(job.durationMs);
    buckets.set(key, row);
  }

  return [...buckets.values()]
    .map((row) => ({
      bucket: row.bucket,
      jobType: row.jobType,
      avgMs:
        row.values.length > 0
          ? Math.round(
              row.values.reduce((sum, value) => sum + value, 0) /
                row.values.length,
            )
          : null,
      p50Ms: percentile(row.values, 0.5),
      p95Ms: percentile(row.values, 0.95),
    }))
    .sort(
      (a, b) =>
        a.bucket.localeCompare(b.bucket) || a.jobType.localeCompare(b.jobType),
    );
}

function buildRecentErrors(jobs: TerminalJob[]) {
  const errors = new Map<
    string,
    { jobType: string; errorClass: string; message: string; count: number }
  >();
  for (const job of jobs) {
    if (!isFailureStatus(job.status) && job.status !== 'partial_failed') {
      continue;
    }
    const message = job.error || 'unknown';
    const errorClass = classifyError(message);
    const key = `${job.jobType}:${errorClass}:${message}`;
    const row = errors.get(key) ?? {
      jobType: job.jobType,
      errorClass,
      message,
      count: 0,
    };
    row.count++;
    errors.set(key, row);
  }
  return [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 20);
}

function bucketIso(date: Date, since: Date, bucketMs: number): string {
  const bucket =
    Math.floor((date.getTime() - since.getTime()) / bucketMs) * bucketMs +
    since.getTime();
  return new Date(bucket).toISOString();
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return Math.round(sorted[index]);
}

function classifyError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('567') || normalized.includes('限流')) {
    return 'rate_limit_567';
  }
  if (normalized.includes('timeout') || normalized.includes('超时')) {
    return 'timeout';
  }
  if (normalized.includes('cookie') || normalized.includes('login')) {
    return 'auth';
  }
  if (normalized.includes('http')) {
    return 'http_error';
  }
  return 'job_failed';
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

function clampRecentMinutes(input: unknown): number {
  const parsed = Number(input);
  return Number.isFinite(parsed)
    ? Math.min(24 * 60, Math.max(1, Math.floor(parsed)))
    : 15;
}

function parseAutoUpdateWindow(input: unknown): AutoUpdateWindow {
  if (input === '24h' || input === '7d') {
    return input;
  }
  return '6h';
}

function autoUpdateWindowConfig(window: AutoUpdateWindow) {
  if (window === '7d') {
    return { minutes: 7 * 24 * 60, bucketMinutes: 60 };
  }
  if (window === '24h') {
    return { minutes: 24 * 60, bucketMinutes: 15 };
  }
  return { minutes: 6 * 60, bucketMinutes: 5 };
}

function autoUpdateRawRowsSql(): string {
  return `
    SELECT
      ts,
      if(eventName = 'auto_update_pressure_snapshot', 1, 0) AS sourcePriority,
      if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        'fcfs',
        attrs['project']
      ) AS project,
      toUInt64OrZero(if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        attrs['dueUsers'],
        attrs['pending']
      )) AS pending,
      toUInt64OrZero(if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        attrs['p50DueAgeMs'],
        attrs['queueP50Ms']
      )) AS p50Ms,
      toUInt64OrZero(if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        attrs['p95DueAgeMs'],
        attrs['queueP95Ms']
      )) AS p95Ms,
      toFloat64OrZero(if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        '0',
        attrs['completePerMinute']
      )) AS completePerMinute,
      toFloat64OrZero(if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        '-1',
        attrs['drainEtaMinutes']
      )) AS drainEtaMinutes,
      toUInt64OrZero(if(
        eventName = 'auto_update_fcfs_backlog_snapshot',
        '0',
        attrs['recentFailures']
      )) AS recentFailures
    FROM structured_logs
    WHERE environment = {environment:String}
      AND ts >= now() - toIntervalMinute({sinceMinutes:UInt32})
      AND eventName IN (
        'auto_update_pressure_snapshot',
        'auto_update_fcfs_backlog_snapshot'
      )
      AND (
        eventName = 'auto_update_fcfs_backlog_snapshot'
        OR attrs['project'] IN ('fcfs', 'settled', 'daily')
      )
  `;
}

function normalizeAutoUpdateRow(row: ClickHouseAutoUpdateRow) {
  const rawEta = numericValue(row.drainEtaMinutes);
  return {
    pending: numericValue(row.pending),
    p50Ms: numericValue(row.p50Ms),
    p95Ms: numericValue(row.p95Ms),
    completePerMinute: numericValue(row.completePerMinute),
    drainEtaMinutes: rawEta < 0 ? null : rawEta,
    recentFailures: numericValue(row.recentFailures),
  };
}

function emptyAutoUpdateMetrics() {
  return {
    pending: 0,
    p50Ms: 0,
    p95Ms: 0,
    completePerMinute: 0,
    drainEtaMinutes: 0,
    recentFailures: 0,
  };
}

function isAutoUpdateProject(value: string): value is AutoUpdateProject {
  return value === 'fcfs' || value === 'settled' || value === 'daily';
}
