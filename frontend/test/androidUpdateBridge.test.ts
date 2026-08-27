import assert from "node:assert/strict";
import test from "node:test";

import {
  getAndroidHostBridge,
  getAndroidImageSaveBridge,
  getAndroidLoginBridge,
  getAndroidSystemBarBridge,
  getAndroidUpdateBridge,
  parseAndroidAppUpdateStatus,
  parseAndroidImageSaveStatus,
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

test("normalizes native image save completion", () => {
  assert.deepEqual(
    parseAndroidImageSaveStatus({
      requestId: "image-request-123",
      message: "图片已保存到相册的 MaiScoreHub 文件夹",
      terminal: true,
      success: true,
      uri: "content://media/external/images/media/123",
    }),
    {
      requestId: "image-request-123",
      message: "图片已保存到相册的 MaiScoreHub 文件夹",
      terminal: true,
      success: true,
      uri: "content://media/external/images/media/123",
    },
  );
  assert.equal(parseAndroidImageSaveStatus({ message: "missing flags" }), null);
});

test("exposes native image saving only for Bridge v3", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = {
    isAvailable: () => true,
    getVersion: () => "0.2.3-beta",
    getBridgeApiVersion: () => 3,
    isOAuthRunning: () => false,
    startOAuth: () => undefined,
    dxnetRequest: () => undefined,
    saveImage: () => undefined,
  };
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { MaiScoreHubAndroid: bridge },
    });
    assert.equal(getAndroidImageSaveBridge(), bridge);
    bridge.getBridgeApiVersion = () => 2;
    assert.equal(getAndroidImageSaveBridge(), null);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("exposes native status-bar styling only for Bridge v4", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = {
    isAvailable: () => true,
    getVersion: () => "0.3.1-beta",
    getBridgeApiVersion: () => 4,
    isOAuthRunning: () => false,
    startOAuth: () => undefined,
    dxnetRequest: () => undefined,
    setStatusBarStyle: () => undefined,
  };
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { MaiScoreHubAndroid: bridge },
    });
    assert.equal(getAndroidSystemBarBridge(), bridge);
    bridge.getBridgeApiVersion = () => 3;
    assert.equal(getAndroidSystemBarBridge(), null);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("computes the workflow SHA-256 digest used by the manifest", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
