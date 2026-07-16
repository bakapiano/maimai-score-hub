import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { MongoClient } from 'mongodb';
import {
  SDGB_INTERACTIVE_QUEUE_NAME,
  SDGB_PROBE_QUEUE_NAME,
} from '@maimai-score-hub/shared';

const mongoDb = process.env.MONGO_DB || 'maimai_web';
const mongoUrl =
  process.env.MONGO_URL ||
  `mongodb://${process.env.MONGO_HOST || '127.0.0.1'}:${
    process.env.MONGO_PORT || '27017'
  }/${mongoDb}`;
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
  ...(process.env.REDIS_PASSWORD
    ? { password: process.env.REDIS_PASSWORD }
    : {}),
  maxRetriesPerRequest: null,
};
const bullmqPrefix =
  process.env.BULLMQ_PREFIX ||
  `${(process.env.REDIS_KEY_PREFIX || 'maimai:').replace(/:+$/, '')}:bull`;

const mongo = new MongoClient(mongoUrl);
const probeQueue = new Queue(SDGB_PROBE_QUEUE_NAME, {
  connection: redisConnection,
  prefix: bullmqPrefix,
});
const interactiveQueue = new Queue(SDGB_INTERACTIVE_QUEUE_NAME, {
  connection: redisConnection,
  prefix: bullmqPrefix,
});

const runId = `lane-smoke-${randomUUID()}`;
const ids = {
  probe: `${runId}-probe`,
  interactive: `${runId}-interactive`,
  wrongLane: `${runId}-wrong-lane`,
};

function document(id, jobType, status) {
  const now = new Date();
  return {
    id,
    jobType,
    status,
    stage: null,
    cleanupStatus: 'not_required',
    cleanupErrorCode: null,
    cleanupUpdatedAt: null,
    cleanupBlockedUntil: null,
    progress: null,
    payload: {},
    result: status === 'completed' ? {} : null,
    error: null,
    errorCode: null,
    executing: false,
    claimedAt: null,
    requesterTag: runId,
    ownerUserId: null,
    ownerFriendCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue?.done) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `condition not met within ${timeoutMs}ms: ${JSON.stringify(lastValue)}`,
  );
}

try {
  await mongo.connect();
  const jobs = mongo.db(mongoDb).collection('sdgb_jobs');
  await jobs.insertMany([
    document(ids.probe, 'get_user_map', 'completed'),
    document(ids.interactive, 'scan_qr', 'completed'),
    document(ids.wrongLane, 'get_user_map', 'queued'),
  ]);

  const options = {
    removeOnComplete: true,
    removeOnFail: { age: 60, count: 10 },
    attempts: 1,
  };
  await probeQueue.add(
    'sdgb-probe-smoke',
    { jobId: ids.probe },
    {
      ...options,
      jobId: ids.probe,
    },
  );
  await interactiveQueue.add(
    'sdgb-interactive-smoke',
    { jobId: ids.interactive },
    { ...options, jobId: ids.interactive },
  );
  await interactiveQueue.add(
    'sdgb-wrong-lane-smoke',
    { jobId: ids.wrongLane },
    { ...options, jobId: ids.wrongLane },
  );

  await waitFor(async () => {
    const [probe, interactive, wrong] = await Promise.all([
      probeQueue.getJob(ids.probe),
      interactiveQueue.getJob(ids.interactive),
      jobs.findOne({ id: ids.wrongLane }),
    ]);
    return {
      done: probe == null && interactive == null && wrong?.status === 'failed',
      probeState: probe ? await probe.getState() : null,
      interactiveState: interactive ? await interactive.getState() : null,
      wrongStatus: wrong?.status,
      wrongError: wrong?.error,
    };
  });

  const wrong = await jobs.findOne({ id: ids.wrongLane });
  assert.match(wrong?.error || '', /routed to interactive, expected probe/);
  console.log(
    JSON.stringify({
      ok: true,
      role: 'all',
      probeQueue: SDGB_PROBE_QUEUE_NAME,
      interactiveQueue: SDGB_INTERACTIVE_QUEUE_NAME,
      wrongLaneRejected: true,
    }),
  );
} finally {
  const jobs = mongo.db(mongoDb).collection('sdgb_jobs');
  for (const [queue, id] of [
    [probeQueue, ids.probe],
    [interactiveQueue, ids.interactive],
    [interactiveQueue, ids.wrongLane],
  ]) {
    const job = await queue.getJob(id).catch(() => undefined);
    await job?.remove().catch(() => undefined);
  }
  await jobs.deleteMany({ requesterTag: runId }).catch(() => undefined);
  await Promise.all([probeQueue.close(), interactiveQueue.close()]);
  await mongo.close();
}
