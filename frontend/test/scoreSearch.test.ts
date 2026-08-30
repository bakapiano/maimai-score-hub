import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScoreSearchIndex,
  ScoreSearchEngine,
  scoreMatchesCatalogSearch,
  searchScoreCandidates,
} from "../src/utils/scoreSearch.ts";

const aliases = new Map<string, string[]>([
  ["10030", ["圣诞歌", "dx鸡公煲"]],
]);

test("score search matches a case-insensitive alias substring", () => {
  assert.equal(
    scoreMatchesCatalogSearch("10030", "ジングルベル", "DX鸡", aliases),
    true,
  );
});

test("score search keeps title and music id matching", () => {
  assert.equal(
    scoreMatchesCatalogSearch("10030", "ジングルベル", "ジングル", aliases),
    true,
  );
  assert.equal(
    scoreMatchesCatalogSearch("10030", "ジングルベル", "0030", aliases),
    true,
  );
});

test("score search normalizes width and whitespace", () => {
  assert.equal(
    scoreMatchesCatalogSearch("10030", "ジングルベル", "  ＤＸ鸡  ", aliases),
    true,
  );
});

test("score search accepts an empty query and rejects unrelated text", () => {
  assert.equal(
    scoreMatchesCatalogSearch("10030", "ジングルベル", "", aliases),
    true,
  );
  assert.equal(
    scoreMatchesCatalogSearch("10030", "ジングルベル", "真爱", aliases),
    false,
  );
});

test("candidate search ranks exact aliases first and exposes the matched alias", () => {
  const index = buildScoreSearchIndex([
    {
      musicId: "10030",
      title: "ジングルベル",
      type: "dx",
      aliases: ["圣诞歌", "dx鸡公煲"],
    },
    {
      musicId: "11844",
      title: "BATTLE NO.1",
      type: "dx",
      aliases: ["鲨鱼娘"],
    },
  ]);

  assert.deepEqual(searchScoreCandidates(index, "鲨鱼娘"), [
    {
      musicId: "11844",
      title: "BATTLE NO.1",
      type: "dx",
      matchedAlias: "鲨鱼娘",
    },
  ]);
});

test("candidate search returns one row per song and respects its result limit", () => {
  const index = buildScoreSearchIndex(
    Array.from({ length: 12 }, (_, index) => ({
      musicId: String(index),
      title: `Candidate ${index}`,
      aliases: [`候选${index}`],
    })),
  );

  assert.equal(searchScoreCandidates(index, "候选", 8).length, 8);
});

test("fuzzy search recovers a candidate when direct matching is empty", () => {
  const engine = new ScoreSearchEngine(
    buildScoreSearchIndex([
      {
        musicId: "11844",
        title: "BATTLE NO.1",
        type: "dx",
        aliases: ["鲨鱼娘"],
      },
    ]),
  );

  assert.deepEqual(engine.candidates("鲨鱼狼"), [
    {
      musicId: "11844",
      title: "BATTLE NO.1",
      type: "dx",
      matchedAlias: "鲨鱼娘",
    },
  ]);
  assert.deepEqual([...engine.matchingMusicIds("鲨鱼狼")], ["11844"]);
});
