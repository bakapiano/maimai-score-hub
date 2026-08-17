import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

import {
  getDxnetPinnedQueueName,
  getDxnetSharedQueueName,
  getDxnetWorkerQueueNames,
  type DxnetWorkerJobData,
} from "@maimai-score-hub/shared";
import { Queue, Worker } from "bullmq";
import { ObjectId } from "mongodb";

import type { SdgbE2eHarness } from "../harness.ts";
import { waitFor } from "../polling.ts";

type FakeBot = {
  friendCode: string;
  cabinetUserId: number;
  workerId: string;
};

export async function verifyDxnetClaimRouting(
  harness: SdgbE2eHarness,
): Promise<void> {
  const db = harness.mongo.db(harness.infrastructure.mongo.database);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const targetFriendCode = numericCode(`91${suffix}`);
  const bots: FakeBot[] = [
    {
      friendCode: numericCode(`81${suffix}`),
      cabinetUserId: 20_000_001,
      workerId: `dxnet-e2e-a-${suffix}`,
    },
    {
      friendCode: numericCode(`82${suffix}`),
      cabinetUserId: 20_000_002,
      workerId: `dxnet-e2e-b-${suffix}`,
    },
  ];
  const now = new Date();
  const userId = new ObjectId();
  await Promise.all([
    db.collection("userentities").insertOne({
      _id: userId,
      friendCode: targetFriendCode,
      username: null,
      cabinetUserId: 30_000_001,
      autoUpdate: false,
      createdAt: now,
      updatedAt: now,
    }),
    db.collection("bot_statuses").insertMany(
      bots.map((bot) => ({
        ...bot,
        available: true,
        lastReportedAt: now,
        friendCount: 0,
        friendsUpdatedAt: now,
        friends: [],
        revision: "e2e",
        consumersReady: getDxnetWorkerQueueNames(bot.friendCode),
      })),
    ),
  ]);

  const control = await api(harness, "/admin/dxnet-routing-control", {
    method: "PATCH",
    body: {
      expectedEpoch: 0,
      botAllowlist: bots.map((bot) => bot.friendCode),
      enabledClaimFlows: ["manual_update"],
      claimCanaryByFlow: { manual_update: null },
    },
  });
  assert.equal(control.status, 200, JSON.stringify(control.body));
  const staleControlPatch = await api(harness, "/admin/dxnet-routing-control", {
    method: "PATCH",
    body: { expectedEpoch: 0, botAllowlist: null },
  });
  assert.equal(staleControlPatch.status, 409);

  const queueName = getDxnetSharedQueueName("user_sync");
  const connection = {
    host: harness.infrastructure.redis.host,
    port: harness.infrastructure.redis.port,
    db: harness.infrastructure.redis.db,
    ...(harness.infrastructure.redis.password
      ? { password: harness.infrastructure.redis.password }
      : {}),
    maxRetriesPerRequest: null,
  };
  const activations: Array<{
    bot: FakeBot;
    attemptsStarted: number;
    priority: number | undefined;
  }> = [];
  let staleStatus: number | null = null;
  const consumers = bots.map(
    (bot) =>
      new Worker<DxnetWorkerJobData>(
        queueName,
        async (delivery) => {
          const attemptsStarted = Math.max(1, delivery.attemptsStarted ?? 1);
          activations.push({
            bot,
            attemptsStarted,
            priority: delivery.opts.priority,
          });
          const execution = {
            deliveryEpoch: delivery.data.deliveryEpoch!,
            attemptsStarted,
            queueName,
            workerId: bot.workerId,
          };
          const started = await api(
            harness,
            `/workers/dxnet/jobs/${delivery.data.jobId}`,
            {
              method: "PATCH",
              body: {
                status: "processing",
                botUserFriendCode: bot.friendCode,
                execution,
              },
            },
          );
          assert.equal(started.status, 200, JSON.stringify(started.body));

          const other = bots.find(
            (candidate) => candidate.friendCode !== bot.friendCode,
          )!;
          const stale = await api(
            harness,
            `/workers/dxnet/jobs/${delivery.data.jobId}`,
            {
              method: "PATCH",
              body: {
                status: "processing",
                botUserFriendCode: other.friendCode,
                execution: { ...execution, workerId: other.workerId },
              },
            },
          );
          staleStatus = stale.status;
          assert.equal(errorCode(stale.body), "stale_execution");

          const prepareBody = {
            execution: {
              deliveryEpoch: execution.deliveryEpoch,
              attemptsStarted: execution.attemptsStarted,
              workerId: execution.workerId,
            },
          };
          const prepared = await Promise.all([
            api(
              harness,
              `/workers/dxnet/jobs/${delivery.data.jobId}/prepare-cabinet-friendship`,
              { method: "POST", body: prepareBody },
            ),
            api(
              harness,
              `/workers/dxnet/jobs/${delivery.data.jobId}/prepare-cabinet-friendship`,
              { method: "POST", body: prepareBody },
            ),
          ]);
          assert.deepEqual(
            prepared.map((result) => result.status),
            [200, 200],
            JSON.stringify(prepared.map((result) => result.body)),
          );
          assert.ok(
            prepared.every(
              (result) =>
                (result.body as { status?: string }).status === "ready",
            ),
          );

          // Eligibility gates new execution ownership. Once this generation
          // is registered, a heartbeat change must not fence its terminal
          // write; execution identity remains the write fence.
          await db
            .collection("bot_statuses")
            .updateOne(
              { friendCode: bot.friendCode },
              { $set: { available: false, consumersReady: [] } },
            );

          const terminal = await api(
            harness,
            `/workers/dxnet/jobs/${delivery.data.jobId}`,
            {
              method: "PATCH",
              body: {
                status: "failed",
                errorCode: "cabinet_friendship_unconfirmed",
                error: "e2e terminal",
                execution,
              },
            },
          );
          assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
        },
        { connection, prefix: harness.bullmqPrefix, concurrency: 1 },
      ),
  );
  const queue = new Queue<DxnetWorkerJobData>(queueName, {
    connection,
    prefix: harness.bullmqPrefix,
  });
  try {
    await Promise.all(consumers.map((consumer) => consumer.waitUntilReady()));
    const token = jwt(
      {
        sub: userId.toHexString(),
        friendCode: targetFriendCode,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "msh-e2e-jwt-secret",
    );
    const created = await api(harness, "/me/dxnet-jobs", {
      method: "POST",
      token,
      body: { jobType: "update_score" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const createdBody = created.body as {
      jobId: string;
      job: {
        priority: number;
        botUserFriendCode: string | null;
        cabinetFriendshipStatus: string;
      };
    };
    assert.equal(createdBody.job.priority, 2);
    assert.equal(createdBody.job.botUserFriendCode, null);
    assert.equal(createdBody.job.cabinetFriendshipStatus, "pending");

    await waitFor(
      "DXNet claim job terminal",
      async () => {
        const row = await db
          .collection("jobs")
          .findOne({ id: createdBody.jobId });
        return {
          done: row?.status === "failed",
          status: row?.status,
          bot: row?.botUserFriendCode,
        };
      },
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    assert.equal(
      activations.length,
      1,
      "BullMQ must select one active consumer",
    );
    assert.equal(activations[0].priority, 3, "business p=2 maps to BullMQ p=3");
    assert.equal(staleStatus, 409);
    const final = await db
      .collection("jobs")
      .findOne({ id: createdBody.jobId });
    assert.equal(final?.botUserFriendCode, activations[0].bot.friendCode);
    assert.equal(final?.execution.workerId, activations[0].bot.workerId);
    assert.equal(final?.routing.deliveryEpoch, 1);
    const addRivalRows = await db
      .collection("sdgb_jobs")
      .find({
        jobType: "add_rival",
        requesterTag: `dxnet-prepare:${createdBody.jobId}`,
      })
      .project({ id: 1, idempotencyKey: 1 })
      .toArray();
    const allSdgbRows = await db
      .collection("sdgb_jobs")
      .find({})
      .project({ id: 1, jobType: 1, requesterTag: 1, idempotencyKey: 1 })
      .toArray();
    const parentAfterPrepare = await db
      .collection("jobs")
      .findOne({ id: createdBody.jobId });
    const collectionNames = (await db.listCollections().toArray()).map(
      (row) => row.name,
    );
    assert.equal(
      addRivalRows.length,
      1,
      `concurrent prepare calls must reuse one add_rival job: ${JSON.stringify({ addRivalRows, allSdgbRows, parentAfterPrepare, collectionNames })}`,
    );
    assert.match(
      String(addRivalRows[0].idempotencyKey),
      new RegExp(`^dxnet:${createdBody.jobId}:`),
    );
    await verifyPinnedInteractiveDelivery(harness, db, bots, token, connection);
  } finally {
    await Promise.allSettled(consumers.map((consumer) => consumer.close(true)));
    await queue.close();
  }
}

async function verifyPinnedInteractiveDelivery(
  harness: SdgbE2eHarness,
  db: ReturnType<SdgbE2eHarness["mongo"]["db"]>,
  bots: FakeBot[],
  token: string,
  connection: {
    host: string;
    port: number;
    db: number;
    password?: string;
    maxRetriesPerRequest: null;
  },
): Promise<void> {
  const activations: Array<{ bot: FakeBot; priority: number | undefined }> = [];
  const consumers = bots.map((bot) => {
    const queueName = getDxnetPinnedQueueName(bot.friendCode, "interactive");
    return new Worker<DxnetWorkerJobData>(
      queueName,
      async (delivery) => {
        activations.push({ bot, priority: delivery.opts.priority });
        const execution = {
          deliveryEpoch: delivery.data.deliveryEpoch!,
          attemptsStarted: Math.max(1, delivery.attemptsStarted ?? 1),
          queueName,
          workerId: bot.workerId,
        };
        const started = await api(
          harness,
          `/workers/dxnet/jobs/${delivery.data.jobId}`,
          {
            method: "PATCH",
            body: {
              status: "processing",
              botUserFriendCode: bot.friendCode,
              execution,
            },
          },
        );
        assert.equal(started.status, 200, JSON.stringify(started.body));
        const terminal = await api(
          harness,
          `/workers/dxnet/jobs/${delivery.data.jobId}`,
          {
            method: "PATCH",
            body: { status: "failed", error: "pinned e2e terminal", execution },
          },
        );
        assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
      },
      { connection, prefix: harness.bullmqPrefix, concurrency: 1 },
    );
  });
  try {
    await Promise.all(consumers.map((consumer) => consumer.waitUntilReady()));
    const created = await api(harness, "/me/dxnet-jobs", {
      method: "POST",
      token,
      body: { jobType: "send_friend_request" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const body = created.body as {
      jobId: string;
      job: { botUserFriendCode: string; priority: number };
    };
    await waitFor(
      "DXNet pinned job terminal",
      async () => {
        const row = await db.collection("jobs").findOne({ id: body.jobId });
        return { done: row?.status === "failed", status: row?.status };
      },
      { timeoutMs: 10_000, intervalMs: 100 },
    );
    assert.equal(activations.length, 1);
    assert.equal(activations[0].bot.friendCode, body.job.botUserFriendCode);
    assert.equal(body.job.priority, 3);
    assert.equal(activations[0].priority, 2);
  } finally {
    await Promise.allSettled(consumers.map((consumer) => consumer.close(true)));
  }
}

async function api(
  harness: SdgbE2eHarness,
  path: string,
  input: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${harness.apiBase}${path}`, {
    method: input.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Secret": harness.config.apiSecret,
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const nested =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : record;
  return typeof nested.code === "string" ? nested.code : undefined;
}

function jwt(payload: Record<string, unknown>, secret: string): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const encodedPayload = encode(payload);
  const content = `${header}.${encodedPayload}`;
  const signature = createHmac("sha256", secret)
    .update(content)
    .digest("base64url");
  return `${content}.${signature}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function numericCode(seed: string): string {
  const digits = seed.replace(/\D/g, "");
  return (digits + "123456789012345").slice(0, 15);
}
