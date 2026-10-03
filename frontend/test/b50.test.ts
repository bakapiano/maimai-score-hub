import assert from "node:assert/strict";
import test from "node:test";
import { buildB50RatingSummary } from "@maimai-score-hub/shared";
import { getRatingFloors } from "../src/utils/ratingFloors.ts";
import type { SyncScore } from "../src/types/syncScore.ts";

function score(musicId: string, rating: number, isNew: boolean): SyncScore {
  return { musicId, rating, isNew, chartIndex: 3, type: "dx" };
}

test("B50 and admission floors use active runners-up in both buckets", () => {
  const active = [
    ...Array.from({ length: 16 }, (_, i) => score(`new-${i}`, 200 + i, true)),
    ...Array.from({ length: 36 }, (_, i) => score(`old-${i}`, 100 + i, false)),
  ];
  const snapshot = [
    score("deleted-new", 999, true),
    score("deleted-old", 999, false),
    ...active,
  ];
  const before = structuredClone(snapshot);
  const catalog = new Map(active.map((s) => [s.musicId, {}]));
  const summary = buildB50RatingSummary(snapshot, catalog);
  assert.equal(summary.newTop.length, 15);
  assert.equal(summary.oldTop.length, 35);
  assert.equal(summary.newTop.at(-1)?.musicId, "new-1");
  assert.equal(summary.oldTop.at(-1)?.musicId, "old-1");
  assert.equal(summary.totalSum, 7250);
  assert.deepEqual(getRatingFloors(snapshot, catalog), {
    newFloor: 201,
    oldFloor: 101,
  });
  assert.deepEqual(snapshot, before);
});

test("catalog changes recompute B50 and vacancies lower admission floors to zero", () => {
  const snapshot = [
    ...Array.from({ length: 15 }, (_, i) => score(`new-${i}`, 200, true)),
    ...Array.from({ length: 35 }, (_, i) => score(`old-${i}`, 100, false)),
  ];
  const catalog = new Set(snapshot.map((s) => s.musicId));
  assert.equal(buildB50RatingSummary(snapshot, catalog).totalSum, 6500);
  assert.deepEqual(getRatingFloors(snapshot, catalog), {
    newFloor: 200,
    oldFloor: 100,
  });
  catalog.delete("new-0");
  catalog.delete("old-0");
  assert.equal(buildB50RatingSummary(snapshot, catalog).totalSum, 6200);
  assert.deepEqual(getRatingFloors(snapshot, catalog), {
    newFloor: 0,
    oldFloor: 0,
  });
  assert.equal(buildB50RatingSummary(snapshot, new Set()).totalSum, 0);
  assert.deepEqual(getRatingFloors(snapshot, new Set()), {
    newFloor: 0,
    oldFloor: 0,
  });
});

test("valid IDs remain exact and eligible scores retain the existing type and version rules", () => {
  const snapshot = [
    score("1", 100, true),
    score("10001", 200, false),
    { ...score("utage", 999, true), type: "utage" },
    { ...score("unknown", 999, true), isNew: null },
    { ...score("unrated", 999, true), rating: null },
    score("invalid", NaN, true),
  ];
  assert.equal(
    buildB50RatingSummary(snapshot, new Set(snapshot.map((s) => s.musicId)))
      .totalSum,
    300,
  );
  assert.equal(
    buildB50RatingSummary(snapshot, new Set(["10001"])).totalSum,
    200,
  );
});
