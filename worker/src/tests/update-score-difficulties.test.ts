import assert from "node:assert/strict";
import test from "node:test";

import { resolveUpdateDifficulties } from "../worker/jobs/handlers/update-score/stages/update_score.ts";

test("an omitted difficulty list defaults to EXPERT through UTAGE", () => {
  assert.deepEqual(resolveUpdateDifficulties(undefined), [2, 3, 4, 10]);
  assert.deepEqual(resolveUpdateDifficulties(null), [2, 3, 4, 10]);
});

test("an explicit difficulty list is deduplicated and sorted", () => {
  assert.deepEqual(resolveUpdateDifficulties([10, 3, 2, 3, 4]), [2, 3, 4, 10]);
  assert.deepEqual(
    resolveUpdateDifficulties([0, 1, 2, 3, 4, 10]),
    [0, 1, 2, 3, 4, 10],
  );
});
