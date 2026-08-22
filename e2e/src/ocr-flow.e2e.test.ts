import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baseUrl = (
  process.env.OCR_E2E_API_BASE ?? "http://127.0.0.1:9050/api/v1"
).replace(/\/+$/, "");
const friendCode = process.env.OCR_E2E_FRIEND_CODE ?? "799999999999922";

async function jsonRequest(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

test("photo batch recognition can be confirmed into a manual score update", async () => {
  const login = await jsonRequest("/auth/login-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      friendCode,
      method: "bot_sends_request",
    }),
  });
  assert.equal(login.status, 201);
  const token = record(login.body).token;
  assert.equal(typeof token, "string");
  const authorization = { Authorization: `Bearer ${String(token)}` };

  const catalog = await jsonRequest("/catalog/music");
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray(catalog.body));
  const rows = catalog.body.map(record);
  const standard = rows.find(
    (row) => row.type === "standard" && Array.isArray(row.charts),
  );
  const dx = rows.find((row) => row.type === "dx" && Array.isArray(row.charts));
  assert.ok(standard, "standard catalog row is required");
  assert.ok(dx, "DX catalog row is required");

  const fixture = await readFile(
    new URL("../../frontend/public/pwa-192x192.png", import.meta.url),
  );
  const fixtureBuffer = new ArrayBuffer(fixture.byteLength);
  new Uint8Array(fixtureBuffer).set(fixture);
  const images = new FormData();
  for (const music of [standard, dx]) {
    const title = String(music.title);
    images.append(
      "images",
      new Blob([fixtureBuffer], { type: "image/png" }),
      `title__${encodeURIComponent(title)}.png`,
    );
  }
  const recognition = await jsonRequest("/me/ocr/recognize", {
    method: "POST",
    headers: authorization,
    body: images,
  });
  assert.equal(recognition.status, 200);
  const recognitionResults = record(recognition.body).results;
  assert.ok(Array.isArray(recognitionResults));
  assert.equal(recognitionResults.length, 2);
  const firstCandidate = record(
    (record(recognitionResults[0]).candidates as unknown[])[0],
  );
  const secondCandidate = record(
    (record(recognitionResults[1]).candidates as unknown[])[0],
  );
  assert.equal(firstCandidate.title, standard.title);
  assert.equal(secondCandidate.title, dx.title);

  const scorePayload = {
    scores: [
      {
        musicId: String(standard.id),
        chartIndex: 3,
        achievement: Number(record(recognitionResults[0]).achievement),
        dxScore: Number(record(recognitionResults[0]).dxScore),
      },
      {
        musicId: String(dx.id),
        chartIndex: 2,
        achievement: Number(record(recognitionResults[1]).achievement),
        dxScore: Number(record(recognitionResults[1]).dxScore),
      },
    ],
  };
  const update = await jsonRequest("/me/sync/scores", {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify(scorePayload),
  });
  assert.equal(update.status, 200);
  assert.equal(record(update.body).submittedChartCount, 2);

  const latest = await jsonRequest("/me/sync/latest", {
    headers: authorization,
  });
  assert.equal(latest.status, 200);
  const savedScores = record(latest.body).scores;
  assert.ok(Array.isArray(savedScores));
  for (const expected of scorePayload.scores) {
    const saved: Record<string, unknown> | undefined = savedScores
      .map(record)
      .find(
      (score) =>
        score.musicId === expected.musicId &&
        score.chartIndex === expected.chartIndex,
      );
    assert.ok(saved, `saved score ${expected.musicId}:${expected.chartIndex}`);
    assert.equal(saved.dxScore, String(expected.dxScore));
  }
});
