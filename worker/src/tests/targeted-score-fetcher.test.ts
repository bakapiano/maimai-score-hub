import assert from "node:assert/strict";
import test from "node:test";

import type { ScoreFetchTarget } from "@maimai-score-hub/shared";
import { ScoreAggregator } from "../worker/jobs/handlers/update-score/stages/score-aggregator.ts";

const target: ScoreFetchTarget = {
  musicId: "100_0",
  title: "Tell Your World",
  type: "standard",
  category: "niconico＆VOCALOID™",
  diff: 0,
  genre: 102,
  level: 1,
};

test("target musicIds and fcfsOnly are independent options", async (t) => {
  await t.test("targeted normal fetch requests both score types", async () => {
    const calls: number[] = [];
    const aggregator = new ScoreAggregator(clientWithLevelPage(calls) as never);

    const result = await aggregator.fetchAndAggregate("friend", {
      targets: [target],
      fcfsOnly: false,
      concurrency: 2,
    });

    assert.deepEqual(calls.sort(), [1, 2]);
    assert.deepEqual(result, {
      targetedScores: [
        {
          musicId: "100_0",
          dxScore: "1001",
          score: "100.0000%",
          fc: "ap",
          fs: "fdx",
        },
      ],
    });
  });

  await t.test("targeted fcfsOnly fetch requests one score type", async () => {
    const calls: number[] = [];
    const aggregator = new ScoreAggregator(clientWithLevelPage(calls) as never);

    const result = await aggregator.fetchAndAggregate("friend", {
      targets: [target],
      fcfsOnly: true,
      concurrency: 2,
    });

    assert.deepEqual(calls, [2]);
    assert.deepEqual(result, {
      targetedScores: [{ musicId: "100_0", fc: "ap", fs: "fdx" }],
    });
  });

  await t.test(
    "full fcfsOnly fetch keeps full coverage with one score type",
    async () => {
      const calls: number[] = [];
      const aggregator = new ScoreAggregator({
        scores: {
          getFriendVS: async (
            _friendCode: string,
            scoreType: 1 | 2,
            diff: number,
          ) => {
            calls.push(scoreType);
            return [
              {
                ...song(scoreType, diff),
                category: "niconico＆VOCALOID™",
              },
            ];
          },
        },
      } as never);

      const result = await aggregator.fetchAndAggregate("friend", {
        difficulties: [0],
        fcfsOnly: true,
      });

      assert.deepEqual(calls, [2]);
      assert.deepEqual(result, {
        "niconico＆VOCALOID™": {
          standard: {
            "Tell Your World": { 0: { level: "1", fc: "ap", fs: "fdx" } },
          },
        },
      });
    },
  );

  await t.test(
    "a missing level row falls back to its concrete genre",
    async () => {
      const calls: string[] = [];
      const aggregator = new ScoreAggregator({
        scores: {
          getFriendVsLevel: async () => {
            calls.push("level");
            return [];
          },
          getFriendVsGenre: async () => {
            calls.push("genre:0:102");
            return [song(2, 0)];
          },
        },
      } as never);

      const result = await aggregator.fetchAndAggregate("friend", {
        targets: [target],
        fcfsOnly: true,
      });

      assert.deepEqual(calls, ["level", "genre:0:102"]);
      assert.deepEqual(result, {
        targetedScores: [{ musicId: "100_0", fc: "ap", fs: "fdx" }],
      });
    },
  );

  await t.test(
    "a missing genre row falls back to its concrete level",
    async () => {
      const calls: string[] = [];
      const flame: ScoreFetchTarget = {
        musicId: "11814_3",
        title: "FLΛME/FRΦST",
        type: "dx",
        category: "舞萌",
        diff: 3,
        genre: 105,
        level: 22,
      };
      const companion: ScoreFetchTarget = {
        musicId: "companion_3",
        title: "Companion",
        type: "dx",
        category: "舞萌",
        diff: 3,
        genre: 105,
        level: 19,
      };
      const aggregator = new ScoreAggregator({
        scores: {
          getFriendVsGenre: async () => {
            calls.push("genre:3:105");
            return [targetSong("Companion", 3)];
          },
          getFriendVsLevel: async (
            _friendCode: string,
            _scoreType: 1 | 2,
            level: number,
          ) => {
            calls.push(`level:${level}`);
            return [targetSong("FLΛME/FRΦST", 3)];
          },
        },
      } as never);

      const result = await aggregator.fetchAndAggregate("friend", {
        targets: [flame, companion],
        fcfsOnly: true,
      });

      assert.deepEqual(calls, ["genre:3:105", "level:22"]);
      assert.deepEqual(result, {
        targetedScores: [
          { musicId: "11814_3", fc: "ap", fs: "fdx" },
          { musicId: "companion_3", fc: "ap", fs: "fdx" },
        ],
      });
    },
  );
});

function clientWithLevelPage(calls: number[]) {
  return {
    scores: {
      getFriendVsLevel: async (_friendCode: string, scoreType: 1 | 2) => {
        calls.push(scoreType);
        return [song(scoreType, 0)];
      },
      getFriendVsGenre: async () => {
        throw new Error("genre fallback should not run");
      },
    },
  };
}

function song(scoreType: 1 | 2, diff: number) {
  return {
    level: "1",
    name: "Tell Your World",
    score: scoreType === 1 ? "1001" : "100.0000%",
    category: null,
    type: "standard" as const,
    fs: "fdx",
    fc: "ap",
    diff,
  };
}

function targetSong(name: string, diff: number) {
  return {
    level: diff === 3 ? "14+" : "1",
    name,
    score: null,
    category: null,
    type: "dx" as const,
    fs: "fdx",
    fc: "ap",
    diff,
  };
}
