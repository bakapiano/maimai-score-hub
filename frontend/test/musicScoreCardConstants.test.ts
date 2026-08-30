import assert from "node:assert/strict";
import test from "node:test";

import {
  DIFFICULTY_NAMES,
  LEVEL_COLORS,
} from "../src/components/MusicScoreCard/constants.ts";

test("utage uses its difficulty label and color", () => {
  assert.equal(DIFFICULTY_NAMES[10], "Utage");
  assert.equal(LEVEL_COLORS[10], "#ff69b4");
});
