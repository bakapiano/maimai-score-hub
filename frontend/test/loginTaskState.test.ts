import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGIN_TASK_CACHE_TTL_MS,
  calculateLoginTaskExpiry,
  persistPendingFriendLogin,
  persistPendingQrLogin,
  readPendingFriendLogin,
  readPendingQrLogin,
  type LoginTaskStorage,
} from "../src/utils/loginTaskCache.ts";
import {
  getJobStatusDisposition,
  parseJobStatus,
} from "../src/utils/jobStatus.ts";

class MemoryStorage implements LoginTaskStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("every DXNet job status has an explicit disposition", () => {
  assert.equal(getJobStatusDisposition("queued"), "active");
  assert.equal(getJobStatusDisposition("processing"), "active");
  assert.equal(getJobStatusDisposition("completed"), "succeeded");
  assert.equal(getJobStatusDisposition("failed"), "failed");
  assert.equal(getJobStatusDisposition("canceled"), "failed");
  assert.equal(parseJobStatus("cancelled"), null);
  assert.equal(parseJobStatus(undefined), null);
});

test("friend-code login cache expires within five minutes", () => {
  const storage = new MemoryStorage();
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const pending = persistPendingFriendLogin(
    "job-1",
    "bot-1",
    new Date(now).toISOString(),
    now,
    storage,
  );

  assert.equal(pending.expiresAt, now + LOGIN_TASK_CACHE_TTL_MS);
  assert.equal(readPendingFriendLogin(now, storage)?.jobId, "job-1");
  assert.equal(
    readPendingFriendLogin(now + LOGIN_TASK_CACHE_TTL_MS, storage),
    null,
  );
});

test("reused login jobs keep the original shorter deadline", () => {
  const now = Date.parse("2026-08-21T12:04:00.000Z");
  const createdAt = "2026-08-21T12:00:00.000Z";
  assert.equal(calculateLoginTaskExpiry(createdAt, now), now + 60_000);
});

test("QR login cache has the same absolute five-minute TTL", () => {
  const storage = new MemoryStorage();
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const pending = persistPendingQrLogin("attempt-1", now, storage);

  assert.equal(pending.expiresAt, now + LOGIN_TASK_CACHE_TTL_MS);
  assert.equal(readPendingQrLogin(now, storage)?.attemptId, "attempt-1");
  assert.equal(
    readPendingQrLogin(now + LOGIN_TASK_CACHE_TTL_MS, storage),
    null,
  );
});

test("malformed login cache entries are discarded", () => {
  const storage = new MemoryStorage();
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  storage.setItem(
    "pendingFriendCodeLogin",
    JSON.stringify({
      version: 1,
      cachedAt: now,
      expiresAt: now + LOGIN_TASK_CACHE_TTL_MS,
      value: { jobId: "", botFriendCode: "", createdAt: "" },
    }),
  );

  assert.equal(readPendingFriendLogin(now, storage), null);
  assert.equal(storage.getItem("pendingFriendCodeLogin"), null);
});
