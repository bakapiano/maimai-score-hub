import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

type FetchEvent = {
  request: { method: string; url: string; mode: string; destination: string };
  respondWith: () => void;
};
const source = readFileSync(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);
for (const [mode, destination] of [
  ["no-cors", "image"],
  ["navigate", "document"],
]) {
  test("service worker bypasses revocable stats SVG: " + mode, () => {
    const handlers = new Map<string, (event: FetchEvent) => void>();
    runInNewContext(source, {
      URL,
      self: {
        location: { origin: "https://local.test" },
        addEventListener: (
          name: string,
          handler: (event: FetchEvent) => void,
        ) => handlers.set(name, handler),
      },
    });
    let intercepted = false;
    handlers.get("fetch")!({
      request: {
        method: "GET",
        url: "https://local.test/stats/" + "a".repeat(32) + "/card.svg",
        mode,
        destination,
      },
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
  });
}
