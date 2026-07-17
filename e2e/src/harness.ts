import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  SDGB_INTERACTIVE_QUEUE_NAME,
  SDGB_PROBE_QUEUE_NAME,
  type SdgbWorkerJobData,
} from "@maimai-score-hub/shared";
import { Queue } from "bullmq";
import {
  MongoClient,
  ObjectId,
  type Collection,
  type Document,
} from "mongodb";
import { createClient } from "redis";

import { loadConfig, repoRoot, type E2eConfig } from "./config.ts";
import {
  startInfrastructure,
  type TestInfrastructure,
} from "./environment.ts";
import {
  laneFor,
  type SdgbJobRecord,
  type SdgbLane,
} from "./job-fixtures.ts";
import { waitFor } from "./polling.ts";
import { getFreePort, ManagedProcess } from "./process-manager.ts";

type WorkerClass = "stable" | "recoverable";
type WorkerSlot = "stable-a" | "stable-b" | "recoverable-a" | "recoverable-b";
type E2eRedisClient = ReturnType<typeof createE2eRedisClient>;

interface DesiredMember {
  workerId: string;
  workerClass: WorkerClass;
  membershipEpoch: number;
  state: "active" | "draining";
}

interface DesiredMemberSet {
  lane: SdgbLane;
  revision: string;
  members: DesiredMember[];
}

export interface MaintenanceRun extends Document {
  requestId: string;
  targetWorkerId: string;
  reason: string;
  state: string;
  hookMayRun: boolean;
  createdAt: Date;
}

interface WorkerDefinition {
  slot: WorkerSlot;
  workerId: string;
  workerClass: WorkerClass;
}

interface StoredWorkerHeartbeat {
  workerId: string;
  workerClass: WorkerClass;
  laneMemberships: Array<{
    lane: SdgbLane;
    state: "active" | "draining";
    membershipEpoch: number;
  }>;
  activeJobsByType: Partial<Record<string, number>>;
  upstreamHealth: string;
  breakerState: string;
  jobsClaimed: number;
}

export class SdgbE2eHarness {
  readonly config: E2eConfig;
  readonly runToken: string;
  readonly redisPrefix: string;
  readonly bullmqPrefix: string;
  readonly infrastructure: TestInfrastructure;
  readonly mongo: MongoClient;
  readonly redis: E2eRedisClient;
  readonly jobs: Collection<SdgbJobRecord>;
  readonly maintenanceRuns: Collection<MaintenanceRun>;
  readonly queues: Record<SdgbLane, Queue<SdgbWorkerJobData, void>>;
  readonly workerIds: Record<WorkerSlot, string>;
  readonly apiBase: string;

  private readonly backend: ManagedProcess;
  private readonly definitions: Record<WorkerSlot, WorkerDefinition>;
  private readonly workers = new Map<WorkerSlot, ManagedProcess>();
  private readonly retiredWorkers: ManagedProcess[] = [];
  private readonly networkEpochs = new Map<WorkerSlot, number>();
  private stopped = false;

  private constructor(input: {
    config: E2eConfig;
    runToken: string;
    infrastructure: TestInfrastructure;
    mongo: MongoClient;
    redis: E2eRedisClient;
    queues: Record<SdgbLane, Queue<SdgbWorkerJobData, void>>;
    backend: ManagedProcess;
    backendPort: number;
    definitions: Record<WorkerSlot, WorkerDefinition>;
  }) {
    this.config = input.config;
    this.runToken = input.runToken;
    this.redisPrefix = `msh:e2e:${input.runToken}:`;
    this.bullmqPrefix = `${this.redisPrefix.replace(/:+$/, "")}:bull`;
    this.infrastructure = input.infrastructure;
    this.mongo = input.mongo;
    this.redis = input.redis;
    this.jobs = input.mongo
      .db(input.infrastructure.mongo.database)
      .collection<SdgbJobRecord>("sdgb_jobs");
    this.maintenanceRuns = input.mongo
      .db(input.infrastructure.mongo.database)
      .collection<MaintenanceRun>("sdgb_maintenance_runs");
    this.queues = input.queues;
    this.backend = input.backend;
    this.apiBase = `http://127.0.0.1:${input.backendPort}/api/v1`;
    this.definitions = input.definitions;
    this.workerIds = Object.fromEntries(
      Object.values(input.definitions).map((definition) => [
        definition.slot,
        definition.workerId,
      ]),
    ) as Record<WorkerSlot, string>;
  }

  static async start(): Promise<SdgbE2eHarness> {
    const config = loadConfig();
    assertSubjectFiles(config);
    const runToken = randomUUID().replaceAll("-", "").slice(0, 12);
    const redisPrefix = `msh:e2e:${runToken}:`;
    const bullmqPrefix = `${redisPrefix.replace(/:+$/, "")}:bull`;
    const infrastructure = await startInfrastructure(config, runToken);
    const mongo = new MongoClient(infrastructure.mongo.url);
    const redis = createE2eRedisClient(infrastructure.redis.url);
    const processes: ManagedProcess[] = [];
    let queues: Record<SdgbLane, Queue<SdgbWorkerJobData, void>> | undefined;
    try {
      await Promise.all([mongo.connect(), redis.connect()]);
      const connection = {
        host: infrastructure.redis.host,
        port: infrastructure.redis.port,
        db: infrastructure.redis.db,
        ...(infrastructure.redis.password
          ? { password: infrastructure.redis.password }
          : {}),
        maxRetriesPerRequest: null,
      };
      queues = {
        probe: new Queue<SdgbWorkerJobData, void>(SDGB_PROBE_QUEUE_NAME, {
          connection,
          prefix: bullmqPrefix,
        }),
        interactive: new Queue<SdgbWorkerJobData, void>(
          SDGB_INTERACTIVE_QUEUE_NAME,
          { connection, prefix: bullmqPrefix },
        ),
      };

      const backendPort = await getFreePort();
      const backend = new ManagedProcess({
        name: "backend",
        command: process.execPath,
        args: ["--enable-source-maps", path.join(repoRoot, "backend", "dist", "main.js")],
        cwd: path.join(repoRoot, "backend"),
        env: backendEnvironment(
          config,
          infrastructure,
          backendPort,
          redisPrefix,
          bullmqPrefix,
        ),
      });
      processes.push(backend);
      await waitFor(
        "E2E Backend health",
        async () => {
          backend.assertRunning();
          const response = await fetch(
            `http://127.0.0.1:${backendPort}/api/v1/health`,
          );
          return { done: response.ok, status: response.status };
        },
        { timeoutMs: 45_000 },
      ).catch((error: unknown) => {
        throw withProcessOutput(error, backend);
      });

      const definitions = workerDefinitions(runToken);
      const harness = new SdgbE2eHarness({
        config,
        runToken,
        infrastructure,
        mongo,
        redis,
        queues,
        backend,
        backendPort,
        definitions,
      });
      for (const definition of Object.values(definitions)) {
        const worker = harness.startWorkerProcess(definition);
        processes.push(worker);
      }
      await harness.waitForPreferredCoverage();
      return harness;
    } catch (error) {
      await Promise.allSettled(
        processes.reverse().map((process) => process.stop()),
      );
      if (queues) {
        await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
      }
      if (redis.isOpen) {
        await redis.quit().catch(() => undefined);
      }
      await mongo.close().catch(() => undefined);
      await infrastructure.stop();
      throw error;
    }
  }

  isWorkerRunning(slot: WorkerSlot): boolean {
    return this.workers.has(slot);
  }

  async stopWorker(slot: WorkerSlot): Promise<void> {
    const worker = this.workers.get(slot);
    if (!worker) {
      return;
    }
    this.workers.delete(slot);
    this.retiredWorkers.push(worker);
    await worker.stop();
  }

  async killWorker(slot: WorkerSlot): Promise<void> {
    const worker = this.workers.get(slot);
    if (!worker) {
      return;
    }
    this.workers.delete(slot);
    this.retiredWorkers.push(worker);
    await worker.kill();
  }

  startWorker(slot: WorkerSlot): void {
    if (this.workers.has(slot)) {
      return;
    }
    this.startWorkerProcess(this.definitions[slot]);
  }

  async waitForPreferredCoverage(): Promise<void> {
    await Promise.all([
      this.waitForActiveMembers("probe", [
        this.workerIds["recoverable-a"],
        this.workerIds["recoverable-b"],
      ]),
      this.waitForActiveMembers("interactive", [
        this.workerIds["stable-a"],
        this.workerIds["stable-b"],
      ]),
    ]);
  }

  async desiredMembers(lane: SdgbLane): Promise<DesiredMember[]> {
    const raw = await this.redis.get(
      `${this.redisPrefix}sdgb:lanes:${lane}:desired-members`,
    );
    if (!raw) {
      return [];
    }
    const desired = JSON.parse(raw) as DesiredMemberSet;
    return desired.members;
  }

  async workerHeartbeat(
    workerId: string,
  ): Promise<StoredWorkerHeartbeat | null> {
    const raw = await this.redis.get(
      `${this.redisPrefix}sdgb:workers:${workerId}`,
    );
    return raw ? (JSON.parse(raw) as StoredWorkerHeartbeat) : null;
  }

  async totalJobsClaimed(): Promise<number> {
    const rows = await Promise.all(
      Object.values(this.workerIds).map((workerId) =>
        this.workerHeartbeat(workerId),
      ),
    );
    return rows.reduce((sum, row) => sum + (row?.jobsClaimed ?? 0), 0);
  }

  async waitForTotalJobsClaimed(expected: number): Promise<void> {
    await waitFor(
      `total sdgb claims=${expected}`,
      async () => {
        const actual = await this.totalJobsClaimed();
        return { done: actual === expected, actual, expected };
      },
      { timeoutMs: 10_000, intervalMs: 100 },
    );
  }

  async waitForWorkerActiveJobs(
    workerId: string,
    minimum: number,
  ): Promise<void> {
    await waitFor(
      `${workerId} active jobs >= ${minimum}`,
      async () => {
        const heartbeat = await this.workerHeartbeat(workerId);
        let active = 0;
        for (const count of Object.values(
          heartbeat?.activeJobsByType ?? {},
        )) {
          active += count ?? 0;
        }
        return { done: active >= minimum, active };
      },
      { timeoutMs: 10_000, intervalMs: 100 },
    );
  }

  async waitForMembershipAbsent(
    lane: SdgbLane,
    workerId: string,
  ): Promise<void> {
    await waitFor(
      `${lane} membership for ${workerId} to expire`,
      async () => {
        const exists = await this.redis.exists(
          `${this.redisPrefix}sdgb:lanes:${lane}:members:${workerId}`,
        );
        return { done: exists === 0, exists };
      },
      { timeoutMs: 10_000, intervalMs: 100 },
    );
  }

  async waitForActiveMembers(
    lane: SdgbLane,
    expectedWorkerIds: readonly string[],
    timeoutMs = 30_000,
  ): Promise<void> {
    const expected = [...expectedWorkerIds].sort();
    await waitFor(
      `${lane} active members [${expected.join(", ")}]`,
      async () => {
        this.assertProcessesRunning();
        const [members, memberKeys] = await Promise.all([
          this.desiredMembers(lane),
          this.redis.keys(
            `${this.redisPrefix}sdgb:lanes:${lane}:members:*`,
          ),
        ]);
        const active = members
          .filter((member) => member.state === "active")
          .map((member) => member.workerId)
          .sort();
        const memberKeyPrefix = `${this.redisPrefix}sdgb:lanes:${lane}:members:`;
        const leased = memberKeys
          .map((key) => key.slice(memberKeyPrefix.length))
          .sort();
        return {
          done: sameStrings(active, expected) && sameStrings(leased, expected),
          active,
          leased,
          desired: members.map((member) => ({
            workerId: member.workerId,
            state: member.state,
          })),
        };
      },
      { timeoutMs, intervalMs: 100 },
    );
  }

  async assertNoMembership(
    lane: SdgbLane,
    workerIds: readonly string[],
  ): Promise<void> {
    const members = await this.desiredMembers(lane);
    const active = new Set(
      members
        .filter((member) => member.state === "active")
        .map((member) => member.workerId),
    );
    const unexpected = workerIds.filter((workerId) => active.has(workerId));
    if (unexpected.length > 0) {
      throw new Error(
        `${lane} unexpectedly active on ${unexpected.join(", ")}`,
      );
    }
  }

  async insertAndEnqueue(records: readonly SdgbJobRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await this.jobs.insertMany([...records]);
    await Promise.all(
      records.map((record) =>
        this.queues[laneFor(record.jobType)].add(
          `sdgb-e2e-${record.jobType}`,
          { jobId: record.id, attempt: record.attempt },
          {
            jobId: `${record.id}~${record.attempt}`,
          },
        ),
      ),
    );
  }

  async insertOnly(records: readonly SdgbJobRecord[]): Promise<void> {
    if (records.length > 0) {
      await this.jobs.insertMany([...records]);
    }
  }

  async enqueueOnLane(record: SdgbJobRecord, lane: SdgbLane): Promise<void> {
    await this.jobs.insertOne(record);
    await this.queues[lane].add(
      `sdgb-e2e-wrong-lane-${record.jobType}`,
      { jobId: record.id, attempt: record.attempt },
      {
        jobId: `${record.id}~${record.attempt}`,
      },
    );
  }

  async waitForJobs(
    requesterTag: string,
    expectedCount: number,
    expectedStatus: "completed" | "failed" = "completed",
    timeoutMs = 45_000,
  ): Promise<SdgbJobRecord[]> {
    await waitFor(
      `${expectedCount} ${expectedStatus} jobs for ${requesterTag}`,
      async () => {
        this.assertProcessesRunning();
        const rows = await this.jobs.find({ requesterTag }).toArray();
        return {
          done:
            rows.length === expectedCount &&
            rows.every((row) => row.status === expectedStatus),
          rows: rows.map((row) => ({
            id: row.id,
            status: row.status,
            worker: row.lastWorkerId,
            attempt: row.attempt,
            error: row.error,
          })),
        };
      },
      { timeoutMs, intervalMs: 100 },
    );
    return this.jobs.find({ requesterTag }).toArray();
  }

  async waitForProcessingJobs(
    requesterTag: string,
    expectedCount: number,
  ): Promise<SdgbJobRecord[]> {
    await waitFor(
      `${expectedCount} processing jobs for ${requesterTag}`,
      async () => {
        const rows = await this.jobs.find({ requesterTag }).toArray();
        return {
          done:
            rows.length === expectedCount &&
            rows.every((row) => row.status === "processing"),
          rows: rows.map((row) => ({
            id: row.id,
            status: row.status,
            worker: row.executionWorkerId,
          })),
        };
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );
    return this.jobs.find({ requesterTag }).toArray();
  }

  async api<T extends Record<string, unknown>>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(this.apiBase + pathname, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-Secret": this.config.apiSecret,
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${pathname} HTTP ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async apiStatus(pathname: string, init: RequestInit = {}): Promise<number> {
    const response = await fetch(this.apiBase + pathname, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-Secret": this.config.apiSecret,
        ...init.headers,
      },
    });
    await response.arrayBuffer();
    return response.status;
  }

  async prepareMusicScoreFixture(): Promise<{
    ownerUserId: string;
    ownerFriendCode: string;
    cabinetUserId: number;
  }> {
    const ownerId = new ObjectId();
    const ownerFriendCode = `9${Date.now().toString().slice(-14)}`;
    const cabinetUserId = 10_000_001;
    const now = new Date();
    const db = this.mongo.db(this.infrastructure.mongo.database);
    await Promise.all([
      db.collection("userentities").insertOne({
        _id: ownerId,
        friendCode: ownerFriendCode,
        username: null,
        passwordHash: null,
        cabinetUserId,
        autoUpdate: false,
        createdAt: now,
        updatedAt: now,
      }),
      db.collection("musics").updateOne(
        { id: "1" },
        {
          $setOnInsert: {
            id: "1",
            title: "E2E Music",
            type: "DX",
            artist: null,
            category: null,
            bpm: null,
            version: null,
            isNew: false,
            charts: [{ cid: "1_0", level: "1", detailLevel: 1 }],
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      ),
    ]);
    return {
      ownerUserId: ownerId.toHexString(),
      ownerFriendCode,
      cabinetUserId,
    };
  }

  async cleanupRequester(requesterTag: string): Promise<void> {
    const rows = await this.jobs
      .find({ requesterTag })
      .project<{ id: string; attempt: number }>({ id: 1, attempt: 1 })
      .toArray();
    for (const row of rows) {
      for (const queue of Object.values(this.queues)) {
        for (let attempt = 0; attempt <= Math.max(row.attempt, 3); attempt += 1) {
          const job = await queue
            .getJob(`${row.id}~${attempt}`)
            .catch(() => undefined);
          await job?.remove().catch(() => undefined);
        }
      }
    }
    await this.jobs.deleteMany({ requesterTag });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await Promise.allSettled(
      [...this.workers.values()].reverse().map((worker) => worker.stop()),
    );
    this.workers.clear();
    await this.backend.stop();
    await Promise.allSettled(
      Object.values(this.queues).map((queue) => queue.close()),
    );
    await this.mongo
      .db(this.infrastructure.mongo.database)
      .dropDatabase()
      .catch(() => undefined);
    if (this.redis.isOpen) {
      const keys = await this.redis
        .keys(`${this.redisPrefix}*`)
        .catch(() => []);
      if (keys.length > 0) {
        await this.redis.del(keys).catch(() => undefined);
      }
      await this.redis.quit().catch(() => undefined);
    }
    await this.mongo.close().catch(() => undefined);
    await this.infrastructure.stop();
  }

  processDiagnostics(): string {
    return [
      ...this.retiredWorkers.slice(-8).map(
        (worker) => `--- ${worker.name} (stopped) ---\n${worker.output()}`,
      ),
      `--- ${this.backend.name} ---\n${this.backend.output()}`,
      ...[...this.workers.values()].map(
        (worker) => `--- ${worker.name} ---\n${worker.output()}`,
      ),
    ].join("\n");
  }

  private startWorkerProcess(definition: WorkerDefinition): ManagedProcess {
    const nextEpoch = (this.networkEpochs.get(definition.slot) ?? Date.now()) + 1;
    this.networkEpochs.set(definition.slot, nextEpoch);
    const worker = new ManagedProcess({
      name: definition.workerId,
      command: process.execPath,
      args: [
        "--enable-source-maps",
        "--experimental-strip-types",
        path.join(this.config.workerDir, "src", "index.ts"),
      ],
      cwd: this.config.workerDir,
      ipc: true,
      env: workerEnvironment(
        this.config,
        this.infrastructure,
        this.apiBase.replace(/\/api\/v1$/, ""),
        this.redisPrefix,
        this.bullmqPrefix,
        definition,
        nextEpoch,
      ),
    });
    this.workers.set(definition.slot, worker);
    return worker;
  }

  private assertProcessesRunning(): void {
    this.backend.assertRunning();
    for (const worker of this.workers.values()) {
      worker.assertRunning();
    }
  }
}

function backendEnvironment(
  config: E2eConfig,
  infrastructure: TestInfrastructure,
  backendPort: number,
  redisPrefix: string,
  bullmqPrefix: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(backendPort),
    FALLBACK_PORT: "0",
    MONGO_HOST: infrastructure.mongo.host,
    MONGO_PORT: String(infrastructure.mongo.port),
    MONGO_DB: infrastructure.mongo.database,
    MONGO_USER: infrastructure.mongo.user ?? "",
    MONGO_PASSWORD: infrastructure.mongo.password ?? "",
    MONGO_AUTH_SOURCE: infrastructure.mongo.authSource,
    MONGO_SERVER_SELECTION_TIMEOUT_MS: "5000",
    REDIS_URL: infrastructure.redis.url,
    REDIS_HOST: infrastructure.redis.host,
    REDIS_PORT: String(infrastructure.redis.port),
    REDIS_DB: String(infrastructure.redis.db),
    REDIS_PASSWORD: infrastructure.redis.password ?? "",
    REDIS_KEY_PREFIX: redisPrefix,
    BULLMQ_PREFIX: bullmqPrefix,
    API_SHARED_SECRET: config.apiSecret,
    ADMIN_PASSWORD: config.apiSecret,
    AUTH_JWT_SECRET: "msh-e2e-jwt-secret",
    SKIP_AUTH: "true",
    OBSERVABILITY_ENABLED: "false",
    SDGB_PROBE_PREFERRED_ACTIVE_COUNT: "2",
    SDGB_PROBE_FALLBACK_ACTIVE_COUNT: "2",
    SDGB_INTERACTIVE_PREFERRED_ACTIVE_COUNT: "2",
    SDGB_INTERACTIVE_FALLBACK_ACTIVE_COUNT: "2",
    SDGB_WORKER_STALE_MS: "900",
    SDGB_WORKER_REGISTRY_TTL_SECONDS: "5",
    SDGB_DESIRED_MEMBERS_TTL_SECONDS: "5",
    SDGB_MEMBERSHIP_RECONCILE_INTERVAL_MS: "200",
    SDGB_QUEUE_REPAIR_STARTUP_DELAY_MS: "250",
    SDGB_QUEUE_REPAIR_INTERVAL_MS: "500",
    SDGB_QUEUE_REPAIR_MIN_AGE_MS: "500",
    SDGB_RECOVERY_HEALTH_INTERVAL_MS: "100",
    SDGB_RECOVERY_CLEAN_WINDOW_MS: "300",
  };
}

function workerEnvironment(
  config: E2eConfig,
  infrastructure: TestInfrastructure,
  backendUrl: string,
  redisPrefix: string,
  bullmqPrefix: string,
  definition: WorkerDefinition,
  networkEpoch: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    ENV_PATH: path.join(repoRoot, ".local-dev", "e2e-no-worker-env"),
    BACKEND_URL: backendUrl,
    API_SHARED_SECRET: config.apiSecret,
    ADMIN_PASSWORD: config.apiSecret,
    WORKER_ID: definition.workerId,
    SDGB_WORKER_CLASS: definition.workerClass,
    SDGB_WORKER_CAPABILITIES: "probe,interactive",
    SDGB_WORKER_VERSION: "e2e",
    SDGB_NETWORK_EPOCH: String(networkEpoch),
    ...(definition.workerClass === "recoverable"
      ? { SDGB_AUTO_RECOVERY_HOOK_KIND: "noop" }
      : { SDGB_AUTO_RECOVERY_HOOK_KIND: "" }),
    SDGB_FAKE_UPSTREAM: "1",
    SDGB_FAKE_UPSTREAM_DELAY_MS: "5",
    SDGB_FAKE_SLOW_DELAY_MS: "1500",
    SDGB_FAKE_EMPTY_WORKER_ID: definition.workerId.replace(
      /(?:stable|recoverable)-[ab]$/,
      "recoverable-a",
    ),
    REDIS_URL: infrastructure.redis.url,
    REDIS_HOST: infrastructure.redis.host,
    REDIS_PORT: String(infrastructure.redis.port),
    REDIS_DB: String(infrastructure.redis.db),
    REDIS_PASSWORD: infrastructure.redis.password ?? "",
    REDIS_KEY_PREFIX: redisPrefix,
    BULLMQ_PREFIX: bullmqPrefix,
    SDGB_WORKER_HEARTBEAT_INTERVAL_MS: "200",
    SDGB_MEMBERSHIP_TTL_MS: "1200",
    SDGB_MEMBERSHIP_RENEW_MS: "250",
    SDGB_RECOVERY_HEALTH_INTERVAL_MS: "100",
    SDGB_RECOVERY_CLEAN_WINDOW_MS: "300",
    SDGB_EMPTY_THRESHOLD: "3",
    SDGB_EMPTY_WINDOW_MS: "10000",
    SDGB_WORKER_CONCURRENCY: "8",
    SDGB_GLOBAL_QPS: "1.5",
    SDGB_GLOBAL_BURST: "1",
    SDGB_RIVAL_QPS: "0.95",
    SDGB_RIVAL_BURST: "1",
    SDGB_MAP_QPS: "0.5",
    SDGB_MAP_BURST: "1",
    SDGB_SCAN_QR_QPS: "1",
    SDGB_SCAN_QR_BURST: "1",
    SDGB_ADD_RIVAL_QPS: "0.5",
    SDGB_ADD_RIVAL_BURST: "1",
    SDGB_GET_MUSIC_SCORE_QPS: "1",
    SDGB_GET_MUSIC_SCORE_BURST: "1",
  };
}

function workerDefinitions(
  runToken: string,
): Record<WorkerSlot, WorkerDefinition> {
  return {
    "stable-a": {
      slot: "stable-a",
      workerId: `e2e-${runToken}-stable-a`,
      workerClass: "stable",
    },
    "stable-b": {
      slot: "stable-b",
      workerId: `e2e-${runToken}-stable-b`,
      workerClass: "stable",
    },
    "recoverable-a": {
      slot: "recoverable-a",
      workerId: `e2e-${runToken}-recoverable-a`,
      workerClass: "recoverable",
    },
    "recoverable-b": {
      slot: "recoverable-b",
      workerId: `e2e-${runToken}-recoverable-b`,
      workerClass: "recoverable",
    },
  };
}

function assertSubjectFiles(config: E2eConfig): void {
  const backendMain = path.join(repoRoot, "backend", "dist", "main.js");
  const workerMain = path.join(config.workerDir, "src", "index.ts");
  if (!existsSync(backendMain)) {
    throw new Error(
      `Backend build not found at ${backendMain}; run npm run build:subjects first`,
    );
  }
  if (!existsSync(workerMain)) {
    throw new Error(
      `sdgb-worker source not found at ${workerMain}; set SDGB_WORKER_DIR`,
    );
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function withProcessOutput(error: unknown, process: ManagedProcess): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\n--- ${process.name} ---\n${process.output()}`);
}

function createE2eRedisClient(url: string) {
  return createClient({ url });
}
