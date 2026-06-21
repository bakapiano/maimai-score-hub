import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { parseFriendRecentEvents } from "../common/maimai/parsers/friend-recent-event-parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  here,
  "fixtures/friend-detail-real-904539980743583-2026-06-19T09-29-47-610Z.html",
);

const html = await readFile(fixture, "utf-8");
const events = parseFriendRecentEvents(html);

assert.deepStrictEqual(events, [
  {
    time: "2026/06/19 12:38",
    songName: "Idoratrize World",
    fc: "ap",
    fs: null,
    difficulty: "expert",
    difficultyImageUrl:
      "https://maimai.wahlap.com/maimai-mobile/img/diff_expert.png",
  },
  {
    time: "2026/06/19 12:31",
    songName: "ビビデバ",
    fc: null,
    fs: "fsp",
    difficulty: "expert",
    difficultyImageUrl:
      "https://maimai.wahlap.com/maimai-mobile/img/diff_expert.png",
  },
  {
    time: "2026/06/13 11:52",
    songName: "生命不詳",
    fc: null,
    fs: "fsp",
    difficulty: "expert",
    difficultyImageUrl:
      "https://maimai.wahlap.com/maimai-mobile/img/diff_expert.png",
  },
]);

console.log(`Parsed and pinned ${events.length} friend recent events.`);
