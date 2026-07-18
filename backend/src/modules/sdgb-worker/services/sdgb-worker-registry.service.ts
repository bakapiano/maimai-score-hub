import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SDGB_LANE_POLICIES,
  type SdgbDesiredMember,
  type SdgbDesiredMemberSet,
  type SdgbLanePolicy,
  type SdgbWorkerDesiredState,
  type SdgbWorkerHeartbeat,
  type SdgbWorkerLane,
} from '@maimai-score-hub/shared';

import { RedisService } from '../../../common/redis/redis.service';
import {
  selectSdgbLaneMembers,
  type SdgbLaneCandidate,
} from './sdgb-lane-selection';

export interface StoredSdgbWorkerHeartbeat extends SdgbWorkerHeartbeat {
  lastSeenAt: string;
  healthySinceAt: string;
  jobsClaimed: number;
}

const LANES: readonly SdgbWorkerLane[] = ['probe', 'interactive'];

@Injectable()
export class SdgbWorkerRegistryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SdgbWorkerRegistryService.name);
  private readonly heartbeatTtlSeconds: number;
  private readonly workerStaleMs: number;
  private readonly desiredTtlSeconds: number;
  private readonly reconcileIntervalMs: number;
  private readonly policies: Record<SdgbWorkerLane, SdgbLanePolicy>;
  private readonly hookKinds: ReadonlySet<string>;
  private interval: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.heartbeatTtlSeconds = positiveInt(
      config,
      'SDGB_WORKER_REGISTRY_TTL_SECONDS',
      45,
    );
    this.workerStaleMs = positiveInt(config, 'SDGB_WORKER_STALE_MS', 30_000);
    this.desiredTtlSeconds = positiveInt(
      config,
      'SDGB_DESIRED_MEMBERS_TTL_SECONDS',
      45,
    );
    this.reconcileIntervalMs = positiveInt(
      config,
      'SDGB_MEMBERSHIP_RECONCILE_INTERVAL_MS',
      5_000,
    );
    this.policies = {
      probe: {
        ...DEFAULT_SDGB_LANE_POLICIES.probe,
        preferredActiveCount: positiveInt(
          config,
          'SDGB_PROBE_PREFERRED_ACTIVE_COUNT',
          DEFAULT_SDGB_LANE_POLICIES.probe.preferredActiveCount,
        ),
        fallbackActiveCount: positiveInt(
          config,
          'SDGB_PROBE_FALLBACK_ACTIVE_COUNT',
          DEFAULT_SDGB_LANE_POLICIES.probe.fallbackActiveCount,
        ),
      },
      interactive: {
        ...DEFAULT_SDGB_LANE_POLICIES.interactive,
        preferredActiveCount: positiveInt(
          config,
          'SDGB_INTERACTIVE_PREFERRED_ACTIVE_COUNT',
          DEFAULT_SDGB_LANE_POLICIES.interactive.preferredActiveCount,
        ),
        fallbackActiveCount: positiveInt(
          config,
          'SDGB_INTERACTIVE_FALLBACK_ACTIVE_COUNT',
          DEFAULT_SDGB_LANE_POLICIES.interactive.fallbackActiveCount,
        ),
      },
    };
    this.hookKinds = new Set(
      (
        config.get<string>('SDGB_MAINTENANCE_HOOK_KINDS') ??
        'router_reboot,noop'
      )
        .split(',')
        .map((kind) => kind.trim())
        .filter(Boolean),
    );
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.warn('Membership reconcile failed: ' + message(error));
      });
    }, this.reconcileIntervalMs);
    this.interval.unref?.();
    void this.reconcile().catch((error: unknown) => {
      this.logger.warn(
        'Initial membership reconcile failed: ' + message(error),
      );
    });
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async heartbeat(
    heartbeat: SdgbWorkerHeartbeat,
    seenAt = new Date(),
  ): Promise<SdgbWorkerDesiredState> {
    this.validateHeartbeat(heartbeat);
    const key = this.workerKey(heartbeat.workerId);
    const previous = await this.redis.getJson<StoredSdgbWorkerHeartbeat>(key);
    this.validateSequence(previous, heartbeat);
    const laneMemberships = await this.validatedMemberships(heartbeat);

    const isContinuouslyHealthy =
      previous?.processGeneration === heartbeat.processGeneration &&
      previous.upstreamHealth === 'healthy' &&
      previous.breakerState === 'closed' &&
      heartbeat.upstreamHealth === 'healthy' &&
      heartbeat.breakerState === 'closed';
    const stored: StoredSdgbWorkerHeartbeat = {
      ...heartbeat,
      capabilities: unique(heartbeat.capabilities),
      laneMemberships,
      lastSeenAt: seenAt.toISOString(),
      healthySinceAt: isContinuouslyHealthy
        ? previous.healthySinceAt
        : seenAt.toISOString(),
      jobsClaimed:
        (previous?.processGeneration === heartbeat.processGeneration
          ? previous.jobsClaimed
          : 0) + heartbeat.jobsClaimedDelta,
    };
    await this.redis.setJson(key, stored, {
      ttlSeconds: this.heartbeatTtlSeconds,
    });
    await this.reconcile();
    return this.getDesiredState(stored);
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) {
      return this.reconciling;
    }
    this.reconciling = this.reconcileWithLock().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  async listWorkers(): Promise<StoredSdgbWorkerHeartbeat[]> {
    const workerPrefix = this.redis.key('sdgb:workers:');
    const keys = await this.redis.keys(workerPrefix + '*');
    const workers: StoredSdgbWorkerHeartbeat[] = [];
    for (const key of keys) {
      if (key.slice(workerPrefix.length).includes(':')) {
        continue;
      }
      const worker = await this.redis.getJson<StoredSdgbWorkerHeartbeat>(key);
      if (worker?.workerId && worker.lastSeenAt) {
        workers.push(worker);
      }
    }
    return workers.sort(
      (a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
    );
  }

  async getDesiredMemberSet(
    lane: SdgbWorkerLane,
  ): Promise<SdgbDesiredMemberSet | null> {
    return this.redis.getJson<SdgbDesiredMemberSet>(this.desiredKey(lane));
  }

  getPolicy(lane: SdgbWorkerLane): SdgbLanePolicy {
    return this.policies[lane];
  }

  async isMembershipActive(
    lane: SdgbWorkerLane,
    workerId: string,
    membershipEpoch: number,
    networkEpoch?: number,
  ): Promise<boolean> {
    const lease = await this.redis.getJson<{
      workerId: string;
      membershipEpoch: number;
      networkEpoch?: number;
    }>(this.redis.key('sdgb:lanes:' + lane + ':members:' + workerId));
    return (
      lease?.workerId === workerId &&
      lease.membershipEpoch === membershipEpoch &&
      (networkEpoch === undefined || lease.networkEpoch === networkEpoch)
    );
  }

  async confirmedActiveMemberIds(lane: SdgbWorkerLane): Promise<string[]> {
    const [desired, workers] = await Promise.all([
      this.getDesiredMemberSet(lane),
      this.listWorkers(),
    ]);
    if (!desired) {
      return [];
    }
    const workersById = new Map(
      workers.map((worker) => [worker.workerId, worker]),
    );
    const confirmed: string[] = [];
    for (const member of desired.members) {
      if (member.state !== 'active') {
        continue;
      }
      const worker = workersById.get(member.workerId);
      const reported = worker?.laneMemberships.find(
        (membership) =>
          membership.lane === lane &&
          membership.state === 'active' &&
          membership.membershipEpoch === member.membershipEpoch,
      );
      if (
        reported &&
        (await this.isMembershipActive(
          lane,
          member.workerId,
          member.membershipEpoch,
          worker?.networkEpoch,
        ))
      ) {
        confirmed.push(member.workerId);
      }
    }
    return confirmed;
  }

  private async reconcileWithLock(): Promise<void> {
    const lockKey = this.redis.key('sdgb:control:membership-reconcile');
    const lockToken = randomUUID();
    const lockTtlMs = Math.max(2_000, this.reconcileIntervalMs - 250);
    if (!(await this.redis.setNx(lockKey, lockToken, lockTtlMs))) {
      return;
    }
    try {
      const allWorkers = await this.listWorkers();
      const eligible = await this.eligibleWorkers(allWorkers);
      for (const lane of LANES) {
        await this.reconcileLane(lane, eligible, allWorkers);
      }
    } finally {
      await this.redis.compareAndDelete(lockKey, lockToken);
    }
  }

  private async reconcileLane(
    lane: SdgbWorkerLane,
    workers: readonly StoredSdgbWorkerHeartbeat[],
    allWorkers: readonly StoredSdgbWorkerHeartbeat[],
  ): Promise<void> {
    const previous = await this.getDesiredMemberSet(lane);
    const currentIds = new Set(
      previous?.members
        .filter((member) => member.state === 'active')
        .map((member) => member.workerId) ?? [],
    );
    const candidates = this.laneCandidates(workers);
    const selected = selectSdgbLaneMembers(
      this.policies[lane],
      candidates,
      currentIds,
    );

    const selectedMembers = await this.buildSelectedMembers(
      lane,
      selected,
      previous,
    );
    const oldLeasedMembers = await this.oldLeasedMembers(
      lane,
      selectedMembers,
      previous,
    );
    const members = await this.resolveLaneTransition(
      lane,
      selectedMembers,
      oldLeasedMembers,
      allWorkers,
    );

    const unchanged =
      previous !== null &&
      previous.members.length === members.length &&
      members.every((member, index) => {
        const old = previous.members[index];
        return (
          old?.workerId === member.workerId &&
          old.workerClass === member.workerClass &&
          old.membershipEpoch === member.membershipEpoch &&
          old.state === member.state
        );
      });
    const next: SdgbDesiredMemberSet = {
      lane,
      revision: unchanged ? previous.revision : randomUUID(),
      updatedAt: new Date().toISOString(),
      members,
    };
    await this.redis.setJson(this.desiredKey(lane), next, {
      ttlSeconds: this.desiredTtlSeconds,
    });
  }

  private laneCandidates(
    workers: readonly StoredSdgbWorkerHeartbeat[],
  ): SdgbLaneCandidate[] {
    return workers.map((worker) => ({
      workerId: worker.workerId,
      workerClass: worker.workerClass,
      capabilities: worker.capabilities,
      activeJobCount: Object.values(worker.activeJobsByType).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      ),
      healthySinceMs: Date.parse(worker.healthySinceAt),
    }));
  }

  private async buildSelectedMembers(
    lane: SdgbWorkerLane,
    selected: readonly SdgbLaneCandidate[],
    previous: SdgbDesiredMemberSet | null,
  ): Promise<SdgbDesiredMember[]> {
    const previousByWorker = new Map(
      previous?.members.map((member) => [member.workerId, member]) ?? [],
    );
    const members: SdgbDesiredMember[] = [];
    for (const worker of selected) {
      const existing = previousByWorker.get(worker.workerId);
      members.push({
        workerId: worker.workerId,
        workerClass: worker.workerClass,
        membershipEpoch:
          existing?.membershipEpoch ??
          (await this.redis.increment(this.membershipEpochKey(lane))),
        state: 'active',
      });
    }
    return members;
  }

  private async oldLeasedMembers(
    lane: SdgbWorkerLane,
    selected: readonly SdgbDesiredMember[],
    previous: SdgbDesiredMemberSet | null,
  ): Promise<SdgbDesiredMember[]> {
    const selectedIds = new Set(selected.map((member) => member.workerId));
    const leased: SdgbDesiredMember[] = [];
    for (const old of previous?.members ?? []) {
      if (
        !selectedIds.has(old.workerId) &&
        (await this.isMembershipActive(lane, old.workerId, old.membershipEpoch))
      ) {
        leased.push(old);
      }
    }
    return leased;
  }

  private async resolveLaneTransition(
    lane: SdgbWorkerLane,
    selected: readonly SdgbDesiredMember[],
    oldLeased: readonly SdgbDesiredMember[],
    workers: readonly StoredSdgbWorkerHeartbeat[],
  ): Promise<SdgbDesiredMember[]> {
    const policy = this.policies[lane];
    const oldPreferred = oldLeased.filter(
      (member) => member.workerClass === policy.preferredClass,
    );
    const oldFallback = oldLeased.filter(
      (member) => member.workerClass === policy.fallbackClass,
    );
    if (
      selected[0]?.workerClass === policy.fallbackClass &&
      oldPreferred.length > 0
    ) {
      return drainMembers(oldPreferred);
    }
    if (
      selected[0]?.workerClass === policy.preferredClass &&
      oldFallback.length > 0
    ) {
      const confirmed = await this.anyMemberConfirmed(lane, selected, workers);
      return [
        ...selected,
        ...oldFallback.map((member) => ({
          ...member,
          state: confirmed ? ('draining' as const) : member.state,
        })),
        ...drainMembers(
          oldLeased.filter(
            (member) => member.workerClass !== policy.fallbackClass,
          ),
        ),
      ];
    }
    return [...selected, ...drainMembers(oldLeased)];
  }

  private async anyMemberConfirmed(
    lane: SdgbWorkerLane,
    members: readonly SdgbDesiredMember[],
    workers: readonly StoredSdgbWorkerHeartbeat[],
  ): Promise<boolean> {
    for (const member of members) {
      const worker = workers.find(
        (candidate) => candidate.workerId === member.workerId,
      );
      const reported = worker?.laneMemberships.some(
        (membership) =>
          membership.lane === lane &&
          membership.state === 'active' &&
          membership.membershipEpoch === member.membershipEpoch,
      );
      if (
        reported &&
        (await this.isMembershipActive(
          lane,
          member.workerId,
          member.membershipEpoch,
          worker?.networkEpoch,
        ))
      ) {
        return true;
      }
    }
    return false;
  }

  private async eligibleWorkers(
    workers: readonly StoredSdgbWorkerHeartbeat[],
  ): Promise<StoredSdgbWorkerHeartbeat[]> {
    const now = Date.now();
    const publicIpCounts = new Map<string, number>();
    for (const worker of workers) {
      if (worker.publicIp) {
        publicIpCounts.set(
          worker.publicIp,
          (publicIpCounts.get(worker.publicIp) ?? 0) + 1,
        );
      }
    }
    const unavailable = new Set<string>();
    await Promise.all(
      workers.map(async (worker) => {
        const [drain, recovery] = await Promise.all([
          this.redis.getJson<unknown>(
            this.redis.key('sdgb:workers:' + worker.workerId + ':drain'),
          ),
          this.redis.getJson<unknown>(
            this.redis.key('sdgb:workers:' + worker.workerId + ':recovery'),
          ),
        ]);
        if (drain || recovery) {
          unavailable.add(worker.workerId);
        }
      }),
    );

    return workers.filter((worker) => {
      if (unavailable.has(worker.workerId)) {
        return false;
      }
      if (now - Date.parse(worker.lastSeenAt) > this.workerStaleMs) {
        return false;
      }
      if (
        worker.lifecycleState !== 'running' ||
        worker.upstreamHealth !== 'healthy' ||
        worker.breakerState !== 'closed'
      ) {
        return false;
      }
      return !worker.publicIp || publicIpCounts.get(worker.publicIp) === 1;
    });
  }

  private async getDesiredState(
    worker: StoredSdgbWorkerHeartbeat,
  ): Promise<SdgbWorkerDesiredState> {
    const desiredLaneMemberships: SdgbWorkerDesiredState['desiredLaneMemberships'] =
      {};
    for (const lane of worker.capabilities) {
      const desired = await this.getDesiredMemberSet(lane);
      const selected = desired?.members.find(
        (member) => member.workerId === worker.workerId,
      );
      const reported = worker.laneMemberships.find(
        (membership) => membership.lane === lane,
      );
      desiredLaneMemberships[lane] = selected
        ? {
            state: selected.state,
            expectedMembershipEpoch: selected.membershipEpoch,
          }
        : reported
          ? {
              state: 'draining',
              expectedMembershipEpoch: reported.membershipEpoch,
            }
          : { state: 'inactive' };
    }

    const recovery = await this.redis.getJson<{ requestId?: string }>(
      this.redis.key('sdgb:workers:' + worker.workerId + ':recovery'),
    );
    const maintenanceRequestId = recovery?.requestId;
    return {
      desiredLaneMemberships,
      ...(maintenanceRequestId ? { maintenanceRequestId } : {}),
    };
  }

  private validateHeartbeat(heartbeat: SdgbWorkerHeartbeat): void {
    if (
      new Set(heartbeat.capabilities).size !== heartbeat.capabilities.length
    ) {
      throw new BadRequestException('worker capabilities must be unique');
    }
    if (
      heartbeat.laneMemberships.some(
        (membership) => !heartbeat.capabilities.includes(membership.lane),
      )
    ) {
      throw new BadRequestException(
        'worker membership must belong to its capabilities',
      );
    }
    if (heartbeat.workerClass === 'recoverable') {
      if (!heartbeat.autoRecoveryHookKind) {
        throw new BadRequestException(
          'recoverable worker requires autoRecoveryHookKind',
        );
      }
      if (!this.hookKinds.has(heartbeat.autoRecoveryHookKind)) {
        throw new BadRequestException(
          'recoverable worker hook kind is not registered',
        );
      }
      if (heartbeat.ratePolicyMode !== 'none') {
        throw new BadRequestException(
          'recoverable worker must use ratePolicyMode=none',
        );
      }
    } else {
      if (heartbeat.autoRecoveryHookKind) {
        throw new BadRequestException(
          'stable worker cannot configure autoRecoveryHookKind',
        );
      }
      if (heartbeat.ratePolicyMode !== 'strict') {
        throw new BadRequestException(
          'stable worker must use ratePolicyMode=strict',
        );
      }
    }
  }

  private async validatedMemberships(
    heartbeat: SdgbWorkerHeartbeat,
  ): Promise<SdgbWorkerHeartbeat['laneMemberships']> {
    const valid: SdgbWorkerHeartbeat['laneMemberships'] = [];
    for (const membership of uniqueMemberships(heartbeat.laneMemberships)) {
      const lease = await this.redis.getJson<{
        workerId: string;
        membershipEpoch: number;
        processGeneration: string;
        networkEpoch: number;
      }>(
        this.redis.key(
          'sdgb:lanes:' + membership.lane + ':members:' + heartbeat.workerId,
        ),
      );
      if (
        lease?.workerId === heartbeat.workerId &&
        lease.membershipEpoch === membership.membershipEpoch &&
        lease.processGeneration === heartbeat.processGeneration &&
        lease.networkEpoch === heartbeat.networkEpoch
      ) {
        valid.push(membership);
      }
    }
    return valid;
  }

  private validateSequence(
    previous: StoredSdgbWorkerHeartbeat | null,
    heartbeat: SdgbWorkerHeartbeat,
  ): void {
    if (
      !previous ||
      previous.processGeneration !== heartbeat.processGeneration
    ) {
      return;
    }
    if (previous.workerClass !== heartbeat.workerClass) {
      throw new BadRequestException(
        'workerClass cannot change within processGeneration',
      );
    }
    if (heartbeat.sequence < previous.sequence) {
      throw new BadRequestException(
        'heartbeat sequence must be monotonically increasing',
      );
    }
  }

  private workerKey(workerId: string): string {
    return this.redis.key('sdgb:workers:' + workerId);
  }

  private desiredKey(lane: SdgbWorkerLane): string {
    return this.redis.key('sdgb:lanes:' + lane + ':desired-members');
  }

  private membershipEpochKey(lane: SdgbWorkerLane): string {
    return this.redis.key('sdgb:lanes:' + lane + ':membership-epoch');
  }
}

function positiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string | number>(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueMemberships(
  values: SdgbWorkerHeartbeat['laneMemberships'],
): SdgbWorkerHeartbeat['laneMemberships'] {
  const byLane = new Map(values.map((value) => [value.lane, value]));
  return [...byLane.values()];
}

function drainMembers(
  members: readonly SdgbDesiredMember[],
): SdgbDesiredMember[] {
  return members.map((member) => ({ ...member, state: 'draining' }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
