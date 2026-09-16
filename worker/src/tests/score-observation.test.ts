import assert from "node:assert/strict";
import test from "node:test";
import { TempCacheBodySchema } from "@maimai-score-hub/shared";
import { parseFriendVsSongs } from "../common/maimai/parsers/friend-vs-parser.ts";
import { ScoreAggregator } from "../worker/jobs/handlers/update-score/stages/score-aggregator.ts";

function page(badges: string) {
  return `<div class="music_master_score_back">
    <div class="music_lv_block">13</div><div class="music_name_block">Song</div>
    <td class="p_r master_score_label w_120 f_b">100.5000%</td>
    <td class="p_r master_score_label w_120 f_b">99.0000%</td>
    ${badges}</div>`;
}

test("explicit empty badge slots survive parsing as null", () => {
  const [song] = parseFriendVsSongs(
    page(`<td class="t_r f_0">
    <img src="music_icon_back.png"><img src="music_icon_back.png"></td>`),
  );
  assert.equal(song.fs, null);
  assert.equal(song.fc, null);
});

test("missing or incomplete badge markup is an unobserved field", () => {
  for (const badges of [
    "",
    '<td class="t_r f_0"><img src="music_icon_fc.png"></td>',
  ]) {
    const [song] = parseFriendVsSongs(page(badges));
    assert.equal(song.fs, undefined);
    assert.equal(song.fc, undefined);
  }
});

test("unknown badge values preserve the independent known badge", () => {
  const [song] = parseFriendVsSongs(
    page(`<td class="t_r f_0">
    <img src="music_icon_future.png"><img src="music_icon_fc.png"></td>`),
  );
  assert.equal(song.fs, undefined);
  assert.equal(song.fc, "fc");
});

test("normal and targeted aggregation keep explicit flag decreases and clears", async () => {
  const getPage = async (_friend: string, scoreType: 1 | 2) => [
    {
      level: "13",
      name: "Song",
      category: "舞萌",
      type: "standard" as const,
      diff: 3,
      score: scoreType === 1 ? "1200" : "99.0000%",
      fc: scoreType === 1 ? "app" : null,
      fs: scoreType === 1 ? "fdxp" : "fs",
    },
  ];
  const aggregator = new ScoreAggregator({
    scores: {
      getFriendVS: getPage,
      getFriendVsLevel: getPage,
      getFriendVsGenre: getPage,
    },
  } as never);
  const full = await aggregator.fetchAndAggregate("friend", {
    difficulties: [3],
  });
  assert.deepEqual(full, {
    舞萌: {
      standard: {
        Song: {
          3: {
            level: "13",
            score: "99.0000%",
            dxScore: "1200",
            fc: null,
            fs: "fs",
          },
        },
      },
    },
  });
  const targeted = await aggregator.fetchAndAggregate("friend", {
    targets: [
      {
        musicId: "17_3",
        title: "Song",
        type: "standard",
        category: "舞萌",
        diff: 3,
        genre: 105,
        level: 19,
      },
    ],
  });
  assert.deepEqual(targeted, {
    targetedScores: [
      {
        musicId: "17_3",
        score: "99.0000%",
        dxScore: "1200",
        fc: null,
        fs: "fs",
      },
    ],
  });
});

test("FC/FS aggregation preserves unavailable fields as omitted", async () => {
  const aggregator = new ScoreAggregator({
    scores: {
      getFriendVS: async () => [
        {
          level: "13",
          name: "Song",
          category: "舞萌",
          type: "standard",
          score: "99.0000%",
          fc: null,
        },
      ],
    },
  } as never);
  const result = await aggregator.fetchAndAggregate("friend", {
    difficulties: [3],
    fcfsOnly: true,
  });
  assert.deepEqual(result, {
    舞萌: { standard: { Song: { 3: { level: "13", fc: null } } } },
  });
});

test("the cache contract preserves missing and explicit empty badges separately", () => {
  const cached = TempCacheBodySchema.parse(
    JSON.parse(
      JSON.stringify({
        songs: [
          {
            level: "13",
            name: "Song",
            category: "舞萌",
            type: "standard",
            score: "99.0000%",
            fc: null,
            fs: undefined,
          },
        ],
      }),
    ),
  );
  assert.equal(cached.songs[0].fc, null);
  assert.equal(Object.hasOwn(cached.songs[0], "fs"), false);
});
