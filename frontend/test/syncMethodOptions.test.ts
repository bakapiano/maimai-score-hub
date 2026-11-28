import assert from "node:assert/strict";
import test from "node:test";

import { getSyncMethodOptions } from "../src/components/syncMethodOptions.ts";

test("regular web keeps Android proxy update out of sync methods", () => {
  const options = getSyncMethodOptions(false);
  const values = options.map((option) => option.value);

  assert.deepEqual(values, ["dxnet_bot", "cabinet_qr", "image_ocr"]);
  assert.deepEqual(options.at(-1), {
    value: "image_ocr",
    name: "成绩图识别",
    description: "上传结算图自动识别并导入",
  });
});

test("Android WebView adds proxy update as the fourth sync method", () => {
  const options = getSyncMethodOptions(true);

  assert.equal(options.length, 4);
  assert.deepEqual(options.at(-1), {
    value: "android_local",
    name: "代理更新",
    description: "通过本机微信直接同步成绩",
  });
});
