import assert from "node:assert/strict";
import test from "node:test";

import { cssColorToOpaqueHex } from "../src/features/android-update/androidSystemBarColor.ts";

test("normalizes opaque computed Header colors", () => {
  assert.equal(cssColorToOpaqueHex("rgb(255, 255, 255)"), "#FFFFFF");
  assert.equal(cssColorToOpaqueHex("rgba(26, 27, 30, 1)"), "#1A1B1E");
  assert.equal(cssColorToOpaqueHex("#f8f9fa"), "#F8F9FA");
});

test("rejects transparent and malformed Header colors", () => {
  assert.equal(cssColorToOpaqueHex("rgba(255, 255, 255, 0.5)"), null);
  assert.equal(cssColorToOpaqueHex("transparent"), null);
  assert.equal(cssColorToOpaqueHex("rgb(300, 0, 0)"), null);
});
