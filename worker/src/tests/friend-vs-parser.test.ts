import { dirname, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import { parseFriendVsSongs } from "../common/maimai/parsers/friend-vs-parser.ts";

// Quick smoke test: read a Friend VS HTML page and dump the parsed songs.
const [, , inputArg] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const defaultSample = resolve(
  here,
  "fixtures/friend-vs-2026-01-17T12-36-36-602Z-type2-diff0-6acde377-7ee5-4896-be34-1f838def003c.html",
);
const target = resolve(here, inputArg ?? defaultSample);

const html = await readFile(target, "utf-8");
console.log("Parsing HTML from", target);
const songs = parseFriendVsSongs(html);
const jsonPath = target.replace(/\.html?$/i, ".json");
await writeFile(jsonPath, JSON.stringify(songs, null, 2), "utf-8");
console.log(`Parsed ${songs.length} songs → ${jsonPath}`);
