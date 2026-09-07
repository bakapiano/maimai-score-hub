import assert from "node:assert/strict";
import test from "node:test";

import { getProberExportCreateError } from "../src/utils/proberExportError.ts";

for (const message of ["Sync not found", "No sync found"]) {
  test(`missing scores (${message}) prompt a sync before export`, () => {
    assert.equal(
      getProberExportCreateError(404, { message }),
      "请先完成一次成绩同步，再导出到查分器。",
    );
  });
}

for (const [field, provider] of [
  ["divingFishImportToken", "水鱼查分器"],
  ["lxnsImportToken", "落雪查分器"],
]) {
  test(`missing ${field} prompts configuring the corresponding provider`, () => {
    assert.equal(
      getProberExportCreateError(400, { message: `User missing ${field}` }),
      `请先配置${provider}的导入 Token。`,
    );
  });
}

for (const [status, message] of [
  [400, "导出队列繁忙，请稍后重试"],
  [401, "Invalid or expired token"],
  [403, "Forbidden"],
  [404, "User not found"],
  [429, "Too many requests"],
  [500, "Internal server error"],
] as const) {
  test(`preserves the actual ${status} error without a credential hint`, () => {
    assert.equal(getProberExportCreateError(status, { message }), message);
  });
}

test("joins validation errors and ignores malformed message entries", () => {
  assert.equal(
    getProberExportCreateError(400, {
      message: [" first error ", null, "", 123, "second error"],
    }),
    "first error；second error",
  );
});

test("unrecognized error bodies get an HTTP fallback", () => {
  for (const body of [null, undefined, "<html>error</html>", {}, { message: 1 }]) {
    assert.equal(
      getProberExportCreateError(502, body),
      "创建导出任务失败（HTTP 502），请稍后重试。",
    );
  }
});

test("a successful HTTP response missing the job ID gets a response error", () => {
  assert.equal(
    getProberExportCreateError(201, { message: "Created" }),
    "导出服务响应异常，请稍后重试。",
  );
});

test("sync guidance is scoped to the known missing-sync 404 response", () => {
  assert.equal(
    getProberExportCreateError(500, { message: "Sync not found" }),
    "Sync not found",
  );
});
