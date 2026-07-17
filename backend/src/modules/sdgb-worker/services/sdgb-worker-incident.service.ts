import { Injectable, Logger } from '@nestjs/common';
import type { SdgbWorkerIncident } from '@maimai-score-hub/shared';

import { RedisService } from '../../../common/redis/redis.service';
import { SdgbWorkerRegistryService } from './sdgb-worker-registry.service';
import { SdgbMaintenanceService } from './sdgb-maintenance.service';

@Injectable()
export class SdgbWorkerIncidentService {
  private readonly logger = new Logger(SdgbWorkerIncidentService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly registry: SdgbWorkerRegistryService,
    private readonly maintenance: SdgbMaintenanceService,
  ) {}

  async report(
    incident: SdgbWorkerIncident,
  ): Promise<{ accepted: boolean; deduplicated: boolean }> {
    const idempotencyKey = this.redis.key(
      'sdgb:incidents:' + incident.incidentId,
    );
    if (
      !(await this.redis.setNx(
        idempotencyKey,
        incident.workerId,
        24 * 60 * 60 * 1000,
      ))
    ) {
      return { accepted: true, deduplicated: true };
    }

    await Promise.all([
      this.redis.setJson(
        this.redis.key('sdgb:workers:' + incident.workerId + ':health'),
        {
          state: 'blocked',
          breakerState: 'open',
          failureClass: incident.failureClass,
          networkEpoch: incident.networkEpoch,
          occurredAt: incident.occurredAt,
        },
        { ttlSeconds: 60 * 60 },
      ),
      this.redis.setJson(
        this.redis.key('sdgb:workers:' + incident.workerId + ':drain'),
        {
          requestId: incident.incidentId,
          reason: incident.failureClass,
          affectedLanes: incident.laneMemberships.map(
            (membership) => membership.lane,
          ),
        },
        { ttlSeconds: 10 * 60 },
      ),
    ]);
    this.logger.error(
      'SDGB worker incident worker=' +
        incident.workerId +
        ' class=' +
        incident.workerClass +
        ' failure=' +
        incident.failureClass,
    );
    await this.registry.reconcile();
    if (incident.workerClass === 'recoverable') {
      const worker = (await this.registry.listWorkers()).find(
        (candidate) => candidate.workerId === incident.workerId,
      );
      if (worker?.autoRecoveryHookKind) {
        await this.maintenance
          .create({
            requestId: incident.incidentId,
            targetWorkerId: incident.workerId,
            affectedLanes: incident.laneMemberships.map(
              (membership) => membership.lane,
            ),
            hookKind: worker.autoRecoveryHookKind,
            reason: 'network_recovery',
            deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          })
          .catch((error: unknown) => {
            this.logger.warn(
              'Auto recovery maintenance not created: ' +
                (error instanceof Error ? error.message : String(error)),
            );
          });
      }
    }
    return { accepted: true, deduplicated: false };
  }
}
