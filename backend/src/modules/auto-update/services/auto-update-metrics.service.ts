import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { CronJob } from 'cron';
import type { Model, PipelineStage } from 'mongoose';

import { RedisService } from '../../../common/redis/redis.service';
import { ObservabilityIngestService } from '../../observability/services/observability-ingest.service';
import { AutoUpdateProbeStateEntity } from '../schemas/auto-update-probe-state.schema';
import {
  AutoUpdateTaskEntity,
  type AutoUpdateTaskType,
} from '../schemas/auto-update-task.schema';

const RATE_WINDOW_MINUTES = 15;
const SNAPSHOT_FENCE_TTL_MS = 120_000;
const PROJECT_TASK_TYPES = {
  fcfs: 'fcfs_enrichment',
  settled: 'settled_full_update',
  daily: 'daily_full_update',
} as const satisfies Record<string, AutoUpdateTaskType>;

type AutoUpdateProject = keyof typeof PROJECT_TASK_TYPES;
type QueueSnapshot = {
  pending: number;
  queuePercentilesMs: number[];
};
type TaskCountRow = { _id: AutoUpdateTaskType; count: number };

@Injectable()
export class AutoUpdateMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoUpdateMetricsService.name);
  private cron: CronJob | null = null;

  constructor(
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly stateModel: Model<AutoUpdateProbeStateEntity>,
    @InjectModel(AutoUpdateTaskEntity.name)
    private readonly taskModel: Model<AutoUpdateTaskEntity>,
    private readonly observability: ObservabilityIngestService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.cron = new CronJob(
      '* * * * *',
      () => {
        this.recordSnapshotOnce().catch((error) =>
          this.logger.warn(
            `failed to record auto-update pressure snapshot: ${
              error instanceof Error ? error.message : error
            }`,
          ),
        );
      },
      null,
      true,
    );
  }

  onModuleDestroy(): void {
    this.cron?.stop();
    this.cron = null;
  }

  async recordSnapshot(now: Date): Promise<void> {
    const since = new Date(now.getTime() - RATE_WINDOW_MINUTES * 60_000);
    const [enabledUsers, fcfs, settled, daily, completed, failures] =
      await Promise.all([
        this.stateModel.countDocuments({ enabled: true }).exec(),
        this.aggregateStateQueue(this.fcfsQueuePipeline(now)),
        this.aggregateStateQueue(this.settledQueuePipeline(now)),
        this.aggregateTaskQueue(now),
        this.aggregateTaskCounts('completed', since),
        this.aggregateTaskCounts('failed', since),
      ]);

    const completedByType = new Map(
      completed.map((row) => [row._id, row.count]),
    );
    const failuresByType = new Map(failures.map((row) => [row._id, row.count]));
    const queues: Record<AutoUpdateProject, QueueSnapshot> = {
      fcfs,
      settled,
      daily,
    };

    this.observability.recordStructuredLogs({
      service: 'backend',
      workerKind: 'backend',
      entries: (Object.keys(PROJECT_TASK_TYPES) as AutoUpdateProject[]).map(
        (project) => {
          const taskType = PROJECT_TASK_TYPES[project];
          const queue = queues[project];
          const completedCount = completedByType.get(taskType) ?? 0;
          const completePerMinute = completedCount / RATE_WINDOW_MINUTES;
          return {
            ts: now.toISOString(),
            level: 'log' as const,
            eventName: 'auto_update_pressure_snapshot',
            message: 'auto_update_pressure_snapshot',
            attrs: {
              project,
              enabledUsers,
              pending: queue.pending,
              queueP50Ms: queue.queuePercentilesMs[0] ?? 0,
              queueP95Ms: queue.queuePercentilesMs[1] ?? 0,
              completePerMinute: round(completePerMinute, 2),
              drainEtaMinutes:
                queue.pending === 0
                  ? 0
                  : completePerMinute > 0
                    ? round(queue.pending / completePerMinute, 1)
                    : -1,
              recentFailures: failuresByType.get(taskType) ?? 0,
              rateWindowMinutes: RATE_WINDOW_MINUTES,
            },
          };
        },
      ),
    });
  }

  private async recordSnapshotOnce(): Promise<void> {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    const won = await this.redis.setNx(
      this.redis.key(`observability:auto-update-pressure:${minute}`),
      '1',
      SNAPSHOT_FENCE_TTL_MS,
    );
    if (won) {
      await this.recordSnapshot(now);
    }
  }

  private aggregateStateQueue(pipeline: PipelineStage[]) {
    return this.stateModel
      .aggregate<QueueSnapshot>(pipeline)
      .exec()
      .then((rows) => rows[0] ?? emptyQueueSnapshot());
  }

  private aggregateTaskQueue(now: Date) {
    return this.taskModel
      .aggregate<QueueSnapshot>([
        {
          $match: {
            type: PROJECT_TASK_TYPES.daily,
            status: 'queued',
            runAt: { $lte: now },
          },
        },
        queuePercentileGroup({ $subtract: [now, '$runAt'] }),
      ])
      .exec()
      .then((rows) => rows[0] ?? emptyQueueSnapshot());
  }

  private aggregateTaskCounts(status: 'completed' | 'failed', since: Date) {
    return this.taskModel
      .aggregate<TaskCountRow>([
        {
          $match: {
            type: { $in: Object.values(PROJECT_TASK_TYPES) },
            status,
            updatedAt: { $gte: since },
          },
        },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ])
      .exec();
  }

  private fcfsQueuePipeline(now: Date): PipelineStage[] {
    return [
      {
        $match: {
          enabled: true,
          'pendingFcfsMusicIds.0': { $exists: true },
          $and: [
            {
              $or: [
                { nextFcfsUpdateAt: null },
                { nextFcfsUpdateAt: { $lte: now } },
              ],
            },
            {
              $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
            },
          ],
        },
      },
      {
        $project: {
          queueAgeMs: {
            $max: [
              0,
              {
                $subtract: [
                  now,
                  {
                    $ifNull: [
                      '$nextFcfsUpdateAt',
                      { $ifNull: ['$pendingFcfsRequestedAt', '$updatedAt'] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      queuePercentileGroup('$queueAgeMs'),
    ];
  }

  private settledQueuePipeline(now: Date): PipelineStage[] {
    return [
      {
        $match: {
          enabled: true,
          pendingFullUpdateAt: { $lte: now },
          $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
        },
      },
      queuePercentileGroup({ $subtract: [now, '$pendingFullUpdateAt'] }),
    ];
  }
}

function queuePercentileGroup(input: unknown): PipelineStage {
  return {
    $group: {
      _id: null,
      pending: { $sum: 1 },
      queuePercentilesMs: {
        $percentile: {
          input,
          p: [0.5, 0.95],
          method: 'approximate',
        },
      },
    },
  } as PipelineStage;
}

function emptyQueueSnapshot(): QueueSnapshot {
  return { pending: 0, queuePercentilesMs: [] };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
