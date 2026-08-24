import assert from "node:assert/strict";
import test from "node:test";

import {
  isOtherLoginType,
  readLoginType,
  readOtherLoginType,
} from "../src/utils/loginType.ts";

test("the four alternate login modes exclude Android WeChat login", () => {
  for (const value of ["friendCode", "password", "qr", "passkey"]) {
    assert.equal(isOtherLoginType(value), true);
  }
  assert.equal(isOtherLoginType("android"), false);
});

test("a regular browser defaults to friend-code login", () => {
  assert.equal(readOtherLoginType(), "friendCode");
  assert.equal(readLoginType(false), "friendCode");
  assert.equal(readLoginType(true), "android");
});
