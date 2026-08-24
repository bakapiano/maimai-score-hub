import assert from "node:assert/strict";
import test from "node:test";

import {
  getAndroidHostBridge,
  getAndroidLoginBridge,
  getAndroidUpdateBridge,
  parseAndroidAppUpdateStatus,
  isAndroidHostBridge,
  parseAndroidUpdateStatus,
} from "../src/features/android-update/androidUpdateBridge.ts";
import { sha256Hex } from "../src/features/android-update/androidWorkflowIntegrity.ts";

test("keeps Android workflow surfaces hidden in a regular browser context", () => {
  assert.equal(getAndroidHostBridge(), null);
  assert.equal(getAndroidUpdateBridge(), null);
  assert.equal(getAndroidLoginBridge(), null);
});

test("recognizes the thin Android transport bridge", () => {
  assert.equal(
    isAndroidHostBridge({
      isAvailable: () => true,
      getVersion: () => "0.2.0",
      getBridgeApiVersion: () => 1,
      isOAuthRunning: () => false,
      startOAuth: () => undefined,
      dxnetRequest: () => undefined,
    }),
    true,
  );
  assert.equal(isAndroidHostBridge({ isAvailable: () => true }), false);
});

test("normalizes dynamic workflow status events", () => {
  assert.deepEqual(
    parseAndroidUpdateStatus({
      message: "正在读取全部成绩 3/5…",
      terminal: false,
      success: false,
      mode: "full",
      stage: "fetch_scores",
      progress: 69,
      details: { current: 3, total: 5 },
      workflowVersion: "2026.08.24.1",
    }),
    {
      message: "正在读取全部成绩 3/5…",
      terminal: false,
      success: false,
      mode: "full",
      stage: "fetch_scores",
      progress: 69,
      details: { current: 3, total: 5 },
      workflowVersion: "2026.08.24.1",
    },
  );
  assert.equal(parseAndroidUpdateStatus({ message: "missing flags" }), null);
});

test("normalizes native application update progress", () => {
  assert.deepEqual(
    parseAndroidAppUpdateStatus({
      requestId: "request-123",
      message: "正在下载安装包",
      stage: "download",
      progress: 140,
      terminal: false,
      success: false,
      releaseId: "android-beta-4-deadbeef",
    }),
    {
      requestId: "request-123",
      message: "正在下载安装包",
      stage: "download",
      progress: 100,
      terminal: false,
      success: false,
      releaseId: "android-beta-4-deadbeef",
    },
  );
});

test("computes the workflow SHA-256 digest used by the manifest", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
