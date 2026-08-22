import assert from "node:assert/strict";
import test from "node:test";

import type { OcrRecognitionItem } from "@maimai-score-hub/shared";

import {
  buildManualScoreUpdates,
  buildScoreOcrDrafts,
} from "../src/features/score-ocr/scoreOcrModel.ts";
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
