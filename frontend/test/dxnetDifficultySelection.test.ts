import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExistingDxnetScores,
  selectDxnetDifficulties,
} from "../src/utils/dxnetDifficultySelection.ts";

test("users without scores hide the option and omit the difficulty list", () => {
  assert.equal(hasExistingDxnetScores(undefined), false);
  assert.equal(hasExistingDxnetScores(0), false);
  assert.equal(selectDxnetDifficulties(false, false), undefined);
  assert.equal(selectDxnetDifficulties(false, true), undefined);
});

test("existing-score updates default to EXPERT through UTAGE", () => {
  assert.equal(hasExistingDxnetScores(1), true);
  assert.deepEqual(selectDxnetDifficulties(true, false), [2, 3, 4, 10]);
});

test("the switch selects every DXNet difficulty", () => {
  assert.deepEqual(selectDxnetDifficulties(true, true), [0, 1, 2, 3, 4, 10]);
});
