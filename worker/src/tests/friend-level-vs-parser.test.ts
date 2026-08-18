import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { parseFriendVsSongs } from "../common/maimai/parsers/friend-vs-parser.ts";

test("parses the real 101 Friend Level VS page with per-chart difficulty", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = resolve(
    here,
    "fixtures/friend-level-vs-level1-2026-08-18.html",
  );
  const songs = parseFriendVsSongs(await readFile(fixture, "utf8"));

  assert.equal(songs.length, 12);
  assert.deepEqual([...new Set(songs.map((song) => song.diff))], [0]);
  assert.deepEqual([...new Set(songs.map((song) => song.type))], ["dx"]);
  assert.ok(songs.every((song) => song.category === null));
  assert.deepEqual(songs[0], {
    level: "1",
    name: "ハム太郎とっとこうた",
    score: null,
    category: null,
    type: "dx",
    fs: null,
    fc: null,
    diff: 0,
  });
});
