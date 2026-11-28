import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeJwtPayload,
  isLegacyAccessToken,
  shouldProactivelyRefresh,
} from "../src/utils/jwtPayload.ts";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("identifies legacy JWTs without sid", () => {
  const legacy = makeJwt({
    sub: "670000000000000000000001",
    friendCode: "634142510810999",
    iat: 1700000000,
    exp: 1702592000,
  });
  const modern = makeJwt({
    sub: "670000000000000000000001",
    friendCode: "634142510810999",
    sid: "670000000000000000000099",
    typ: "access",
    iat: 1700000000,
    exp: 1700604800,
  });

  assert.equal(isLegacyAccessToken(legacy), true);
  assert.equal(isLegacyAccessToken(modern), false);
  assert.equal(isLegacyAccessToken("not-a-jwt"), false);
  assert.equal(decodeJwtPayload(modern)?.sid, "670000000000000000000099");
});

test("detects tokens within proactive refresh window (3 days)", () => {
  const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);

  const farToken = makeJwt({ exp: nowSec + 5 * 86_400 });
  const nearToken = makeJwt({ exp: nowSec + 2 * 86_400 });
  const expiredToken = makeJwt({ exp: nowSec - 60 });

  assert.equal(shouldProactivelyRefresh(farToken, nowMs), false);
  assert.equal(shouldProactivelyRefresh(nearToken, nowMs), true);
  assert.equal(shouldProactivelyRefresh(expiredToken, nowMs), true);
});
