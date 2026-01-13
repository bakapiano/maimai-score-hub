import { dirname, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import { parseFriendVsSongs } from "./parsers/index.ts";

// Quick smoke test: read a Friend VS HTML page and dump the parsed songs.
const [, , inputArg] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const defaultSample =
  "C:\\Users\\Administrator\\Desktop\\maimaidx-prober-proxy-updater\\v2\\worker\\debug-html\\friend-vs-2025-12-31T07-28-26-443Z-type2-diff0-5ab625ce-bbe8-4f0e-a52a-d773bb1093c3.html";
const target = resolve(here, inputArg ?? defaultSample);

const html = await readFile(target, "utf-8");
console.log("Parsing HTML from", target);
const songs = parseFriendVsSongs(html);
const jsonPath = target.replace(/\.html?$/i, ".json");
await writeFile(jsonPath, JSON.stringify(songs, null, 2), "utf-8");
console.log(`Parsed ${songs.length} songs → ${jsonPath}`);
