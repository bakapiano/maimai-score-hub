import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import mongoose from "../../backend/node_modules/mongoose/index.js";

const artifactDirectory = fileURLToPath(
  new URL("../app/build/real-device-e2e/", import.meta.url),
);
const connection = await mongoose
  .createConnection(
    process.env.MSH_ANDROID_E2E_MONGO_URL ??
      "mongodb://127.0.0.1:27017/maimai_web",
  )
  .asPromise();

try {
  const syncs = connection.collection("syncs");
  const users = connection.collection("userentities");
  const latest = await syncs.find({}).sort({ updatedAt: -1 }).limit(1).next();
  const baseline = {
    capturedAt: new Date().toISOString(),
    syncCount: await syncs.countDocuments(),
    userCount: await users.countDocuments(),
    latestUpdatedAt: latest?.updatedAt ?? null,
    latestVersion: Number(latest?.__v ?? 0),
    latestFriendCodeHash: latest?.friendCode
      ? createHash("sha256").update(String(latest.friendCode)).digest("hex")
      : null,
  };
  await writeFile(
    `${artifactDirectory}backend-baseline.json`,
    JSON.stringify(baseline, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      ...baseline,
      latestFriendCodeHash: baseline.latestFriendCodeHash?.slice(0, 12) ?? null,
    }),
  );
} finally {
  await connection.close();
}
