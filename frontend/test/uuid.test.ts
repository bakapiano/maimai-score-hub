import assert from "node:assert/strict";
import test from "node:test";

import { createUuid } from "../src/utils/uuid.ts";

test("uses the native UUID implementation when available", () => {
  const expected = "12345678-1234-4123-8123-123456789abc";
  assert.equal(createUuid({ randomUUID: () => expected }), expected);
});

test("creates an RFC 4122 UUID with the Chrome 77 Web Crypto fallback", () => {
  const uuid = createUuid({
    getRandomValues: (bytes) => {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return bytes;
    },
  });

  assert.equal(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("keeps the UUID shape in a restricted WebView without Web Crypto", () => {
  assert.match(
    createUuid(null),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
