import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import mongoose from "../../backend/node_modules/mongoose/index.js";

const artifactDirectory = fileURLToPath(
  new URL("../app/build/real-device-e2e/", import.meta.url),
);
const baseline = JSON.parse(
  await readFile(`${artifactDirectory}backend-baseline.json`, "utf8"),
);
const capturedAt = new Date(baseline.capturedAt);
const connection = await mongoose
  .createConnection(
    process.env.MSH_ANDROID_E2E_MONGO_URL ??
      "mongodb://127.0.0.1:27017/maimai_web",
  )
  .asPromise();

try {
  const syncs = connection.collection("syncs");
  const users = connection.collection("userentities");
  const changes = connection.collection("score_changes");
  const sync = await syncs
    .find({ updatedAt: { $gt: capturedAt } })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (!sync) {
    throw new Error("No sync was written after the E2E baseline");
  }
  if (!Array.isArray(sync.scores) || sync.scores.length === 0) {
    throw new Error("The E2E sync contains no scores");
  }
  const owner = sync.ownerUserId
    ? await users.findOne({ _id: sync.ownerUserId })
    : null;
  if (!owner || String(owner.friendCode) !== String(sync.friendCode)) {
    throw new Error("Sync ownership does not match the authenticated user");
  }
  if (sync.lastSourceType !== "manual_score_update") {
    throw new Error("The latest merge did not come from the authenticated score endpoint");
  }
  if (!sync.lastMergedAt || new Date(sync.lastMergedAt) <= capturedAt) {
    throw new Error("The E2E score submission did not advance lastMergedAt");
  }
  const manualChangeCount = await changes.countDocuments({
    friendCode: sync.friendCode,
    sourceType: "manual_score_update",
    observedAt: { $gt: capturedAt },
  });
  const verification = {
    verifiedAt: new Date().toISOString(),
    baselineCapturedAt: baseline.capturedAt,
    friendCodeHash: createHash("sha256")
      .update(String(sync.friendCode))
      .digest("hex"),
    syncId: sync.id,
    scoreVersion: Number(sync.__v ?? 0),
    scoreCount: sync.scores.length,
    manualChangeCount,
    idempotentWrite: manualChangeCount === 0,
    lastSourceType: sync.lastSourceType,
    lastMergedAt: sync.lastMergedAt,
    updatedAt: sync.updatedAt,
    scoreUpdatedAt: sync.scoreUpdatedAt ?? null,
  };
  await writeFile(
    `${artifactDirectory}backend-verification.json`,
    JSON.stringify(verification, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      ...verification,
      friendCodeHash: verification.friendCodeHash.slice(0, 12),
    }),
  );
} finally {
  await connection.close();
}
