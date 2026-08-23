import assert from "node:assert/strict";
import test from "node:test";

import type { OcrRecognitionItem } from "@maimai-score-hub/shared";

import {
  buildManualScoreUpdates,
  buildScoreOcrDrafts,
  getOcrCandidateMusics,
} from "../src/features/score-ocr/scoreOcrModel.ts";
import { getDxStarForScore } from "../src/utils/dxScore.ts";
import type { MusicRow } from "../src/types/music.ts";

const musics: MusicRow[] = [
  {
    id: "1001",
    title: "METATRON",
    type: "standard",
    charts: [{}, {}, {}, { notes: { tap: 800, hold: 20 } }],
  },
  {
    id: "11001",
    title: "METATRON",
    type: "dx",
    charts: [{}, {}, {}, { notes: { tap: 1000 } }],
  },
];

const recognition: OcrRecognitionItem = {
  index: 0,
  filename: "metatron.jpg",
  status: "ok",
  candidates: [
    {
      title: "METATRON",
      confidence: 0.99,
      sources: ["cover", "title"],
    },
  ],
  achievement: 100.8039,
  dxScore: 2400,
  difficulty: "master",
  level: "14",
  isDx: false,
  fc: null,
  fs: null,
  error: null,
};

test("recognition defaults to the matching song type and difficulty", () => {
  const [draft] = buildScoreOcrDrafts([recognition], musics);
  assert.equal(draft.musicId, "1001");
  assert.equal(draft.chartIndex, 3);
  assert.equal(draft.selected, true);
});

test("music choices follow OCR candidate order and include matching song types", () => {
  const matches = getOcrCandidateMusics(
    [
      { title: "  song a  ", confidence: 0.9, sources: ["title"] },
      { title: "Song B", confidence: 0.8, sources: ["cover"] },
      { title: "SONG A", confidence: 0.7, sources: ["cover"] },
    ],
    [
      { id: "a-standard", title: "Song A", type: "standard" },
      { id: "unrelated", title: "Other", type: "dx" },
      { id: "a-dx", title: "Song A", type: "dx" },
      { id: "b-standard", title: "Song B", type: "standard" },
    ],
  );

  assert.deepEqual(
    matches.map((music) => music.id),
    ["a-standard", "a-dx", "b-standard"],
  );
});

test("confirmed OCR drafts become manual score updates", () => {
  const drafts = buildScoreOcrDrafts([recognition], musics);
  const result = buildManualScoreUpdates(drafts, musics);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.scores, [
    {
      musicId: "1001",
      chartIndex: 3,
      achievement: 100.8039,
      dxScore: 2400,
    },
  ]);
});

test("DX score is checked against the selected chart maximum", () => {
  const drafts = buildScoreOcrDrafts([recognition], musics);
  drafts[0].dxScore = 9999;
  const result = buildManualScoreUpdates(drafts, musics);
  assert.equal(result.scores.length, 0);
  assert.match(result.errors[0].message, /谱面上限/);
});

test("OCR result uses the score detail DX star thresholds", () => {
  assert.equal(getDxStarForScore(2_116, 2_295), 2);
  assert.equal(getDxStarForScore(2_575, 2_775), 2);
  assert.equal(getDxStarForScore(2_100, null), null);
});
