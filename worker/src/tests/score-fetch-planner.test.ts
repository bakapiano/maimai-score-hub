import assert from "node:assert/strict";
import test from "node:test";

import type { ScoreFetchTarget } from "@maimai-score-hub/shared";
import { planScoreFetchPages } from "../worker/jobs/handlers/update-score/stages/score-fetch-planner.ts";

test("chooses a small level page for one chart", () => {
  assert.deepEqual(planScoreFetchPages([target("100_0", 0, 105, 1)]), [
    { kind: "level", level: 1, estimatedSongs: 12 },
  ]);
});

test("shares one genre page across targets with expensive levels", () => {
  assert.deepEqual(
    planScoreFetchPages([
      target("100_4", 4, 106, 19),
      target("101_4", 4, 106, 20),
    ]),
    [{ kind: "genre", diff: 4, genre: 106, estimatedSongs: 3 }],
  );
});

test("shares one level page across different genres and diffs", () => {
  assert.deepEqual(
    planScoreFetchPages([
      target("100_0", 0, 101, 1),
      target("101_1", 1, 105, 1),
    ]),
    [{ kind: "level", level: 1, estimatedSongs: 12 }],
  );
});

test("uses the dedicated UTAGE page and concrete genres for normal charts", () => {
  const pages = planScoreFetchPages([
    {
      ...target("100018_0", 10, 99, null),
      type: "utage",
      category: "宴会場",
    },
    target("100_3", 3, 101, 19),
  ]);

  assert.ok(
    pages.some(
      (page) => page.kind === "genre" && page.diff === 10 && page.genre === 99,
    ),
  );
  assert.ok(
    pages.every(
      (page) => page.kind !== "genre" || page.diff === 10 || page.genre !== 99,
    ),
  );
});

function target(
  musicId: string,
  diff: number,
  genre: number,
  level: number | null,
): ScoreFetchTarget {
  return {
    musicId,
    title: musicId,
    type: "standard",
    category: "舞萌",
    diff,
    genre,
    level,
  };
}
