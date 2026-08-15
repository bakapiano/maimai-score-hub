import { MongoClient } from 'mongodb';

async function main(): Promise<void> {
  const client = new MongoClient(mongoUrl());
  await client.connect();
  try {
    const database =
      process.env.MONGO_DB ||
      (process.env.MONGO_URL ? undefined : 'maimai_web');
    const db = client.db(database);
    const jobs = db.collection('jobs');
    const sdgbJobs = db.collection('sdgb_jobs');
    const control = db.collection('dxnet_routing_control');
    const migrations = db.collection('schema_migrations');
    const cutoverKey = 'dxnet-routing-v2-cutover';
    const cutoverMarker = await migrations.findOne({ key: cutoverKey });
    if (!cutoverMarker) {
      if (process.env.DXNET_V2_CUTOVER_CONFIRMED !== 'true') {
        throw new Error(
          'DXNet routing-v2 cutover requires confirm_dxnet_v2_cutover=true',
        );
      }
      const freshWorkerCutoff = new Date(Date.now() - 90_000);
      const onlineBots = await db
        .collection('bot_statuses')
        .find({ available: true, lastReportedAt: { $gte: freshWorkerCutoff } })
        .project({ friendCode: 1, _id: 0 })
        .toArray();
      if (onlineBots.length > 0) {
        throw new Error(
          `DXNet workers still report online: ${onlineBots.map((row) => String(row.friendCode)).join(', ')}`,
        );
      }
    }
    const cutover = await jobs.updateMany(
      {
        status: { $in: ['queued', 'processing'] },
        'routing.version': { $ne: 2 },
      },
      {
        $set: {
          status: 'canceled',
          runAt: null,
          error: 'Canceled during routing-v2 cutover',
          updatedAt: new Date(),
        },
      },
    );
    await jobs.createIndex(
      { 'routing.version': 1, status: 1, deadlineAt: 1 },
      { name: 'routing_status_deadline' },
    );
    await jobs.createIndex(
      { 'routing.version': 1, 'routing.lane': 1, status: 1 },
      { name: 'routing_lane_status' },
    );
    await jobs.createIndex(
      { botUserFriendCode: 1, status: 1 },
      { name: 'bot_status' },
    );
    await sdgbJobs.createIndex(
      { idempotencyKey: 1 },
      {
        name: 'idempotency_key_unique',
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
    );
    await control.createIndex(
      { key: 1 },
      { name: 'routing_control_key_unique', unique: true },
    );
    await migrations.updateOne(
      { key: cutoverKey },
      { $setOnInsert: { key: cutoverKey, completedAt: new Date() } },
      { upsert: true },
    );
    console.log(
      `DXNet routing indexes are ready; canceled ${cutover.modifiedCount} pre-v2 jobs`,
    );
  } finally {
    await client.close();
  }
}

function mongoUrl(): string {
  if (process.env.MONGO_URL) {
    return process.env.MONGO_URL;
  }
  const host = process.env.MONGO_HOST || '127.0.0.1';
  const port = process.env.MONGO_PORT || '27017';
  const database = process.env.MONGO_DB || 'maimai_web';
  const user = process.env.MONGO_USER;
  const password = process.env.MONGO_PASSWORD;
  if (!user || !password) {
    return `mongodb://${host}:${port}/${database}`;
  }
  const authSource = process.env.MONGO_AUTH_SOURCE || 'admin';
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?authSource=${encodeURIComponent(authSource)}`;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
