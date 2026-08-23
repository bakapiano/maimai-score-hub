import assert from "node:assert/strict";
import test from "node:test";

import { getAndroidUpdatePresentation } from "../src/features/android-update/androidUpdatePresentation.ts";

test("presents an idle proxy update like the DXNET status row", () => {
  assert.deepEqual(
    getAndroidUpdatePresentation({
      mode: "recent",
      running: false,
      status: null,
    }),
    {
      color: "gray",
      label: "等待代理更新",
      text: "读取最近游玩并写入当前账号",
      badge: null,
      state: "idle",
      progress: 0,
    },
  );
});

test("maps full-score native stages to increasing progress", () => {
  const first = getAndroidUpdatePresentation({
    mode: "full",
    running: true,
    status: {
      message: "正在读取全部成绩 1/5…",
      terminal: false,
      success: false,
      mode: "full",
    },
  });
  const last = getAndroidUpdatePresentation({
    mode: "full",
    running: true,
    status: {
      message: "正在读取全部成绩 5/5…",
      terminal: false,
      success: false,
      mode: "full",
    },
  });

  assert.equal(first.label, "代理更新中");
  assert.equal(first.badge, "读取成绩 1/5");
  assert.equal(first.progress, 53);
  assert.equal(last.badge, "读取成绩 5/5");
  assert.equal(last.progress, 85);
});

test("presents terminal proxy update outcomes", () => {
  const completed = getAndroidUpdatePresentation({
    mode: "recent",
    running: false,
    status: {
      message: "更新完成：提交 12 条，提升 3 条，版本 8",
      terminal: true,
      success: true,
      mode: "recent",
    },
  });
  const failed = getAndroidUpdatePresentation({
    mode: "recent",
    running: false,
    status: {
      message: "更新失败：DXNET 会话过期",
      terminal: true,
      success: false,
      mode: "recent",
    },
  });

  assert.equal(completed.state, "completed");
  assert.equal(completed.progress, 100);
  assert.equal(failed.state, "failed");
  assert.equal(failed.badge, "更新失败");
});
