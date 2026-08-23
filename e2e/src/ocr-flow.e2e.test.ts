import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import test from "node:test";

const baseUrl = (
  process.env.OCR_E2E_API_BASE ?? "http://127.0.0.1:3001/api/v1"
).replace(/\/+$/, "");
const friendCode = process.env.OCR_E2E_FRIEND_CODE ?? "799999999999922";
const ocrHealthUrl =
  process.env.OCR_E2E_HEALTH_URL ?? "http://127.0.0.1:19100/healthz";
const defaultRealImages = [
  "D:\\ocr\\ocr\\datasets\\anchors_clean\\maimai_dx_2022_2023\\images\\val\\2023-06-18_212049.jpg",
  "D:\\ocr\\ocr\\datasets\\anchors_clean\\maimai_dx_2024_2025\\images\\val\\2024-06-14_220347.jpg",
];

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

async function appendRecognitionImages(
  images: FormData,
  standard: Record<string, unknown>,
  dx: Record<string, unknown>,
) {
  const healthResponse = await fetch(ocrHealthUrl);
  assert.equal(healthResponse.status, 200);
  const health = record(await healthResponse.json());
  if (health.mode === "real") {
    const paths = process.env.OCR_E2E_REAL_IMAGES
      ? process.env.OCR_E2E_REAL_IMAGES.split(delimiter).filter(Boolean)
      : defaultRealImages;
    assert.ok(paths.length >= 2, "real OCR E2E needs at least two images");
    for (const path of paths.slice(0, 2)) {
      await access(path);
      const image = await readFile(path);
      images.append(
        "images",
        new Blob([image], { type: "image/jpeg" }),
        path.replace(/^.*[\\/]/, ""),
      );
    }
    return;
  }

  const fixture = await readFile(
    new URL("../../frontend/public/pwa-192x192.png", import.meta.url),
  );
  for (const music of [standard, dx]) {
    images.append(
      "images",
      new Blob([fixture], { type: "image/png" }),
      `title__${encodeURIComponent(String(music.title))}.png`,
    );
  }
}

function resolveRecognizedScore(
  result: Record<string, unknown>,
  catalog: Record<string, unknown>[],
) {
  const candidates = result.candidates;
  assert.ok(Array.isArray(candidates) && candidates.length > 0);
  const desiredType =
    result.isDx === true
      ? "dx"
      : result.isDx === false
        ? "standard"
        : undefined;
  const music = candidates
    .map(record)
    .map((candidate) =>
      catalog.find(
        (row) =>
          row.title === candidate.title &&
          (desiredType === undefined || row.type === desiredType),
      ),
    )
    .find(Boolean);
  assert.ok(music, `catalog match is required for ${String(candidates[0])}`);
  const difficultyIndex: Record<string, number> = {
    basic: 0,
    advanced: 1,
    expert: 2,
    master: 3,
    remaster: 4,
    utage: 10,
  };
  const chartIndex = difficultyIndex[String(result.difficulty)] ?? 3;
  const achievement =
    typeof result.achievement === "number" ? result.achievement : undefined;
  const dxScore = typeof result.dxScore === "number" ? result.dxScore : undefined;
  assert.ok(
    achievement !== undefined || dxScore !== undefined,
    "recognized result needs a score field",
  );
  return {
    musicId: String(music.id),
    chartIndex,
    ...(achievement === undefined ? {} : { achievement }),
    ...(dxScore === undefined ? {} : { dxScore }),
  };
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

  const images = new FormData();
  await appendRecognitionImages(images, standard, dx);
  const recognition = await jsonRequest("/me/ocr/recognize", {
    method: "POST",
    headers: authorization,
    body: images,
  });
  assert.equal(recognition.status, 200);
  const recognitionResults = record(recognition.body).results;
  assert.ok(Array.isArray(recognitionResults));
  assert.equal(recognitionResults.length, 2);
  const scorePayload = {
    scores: recognitionResults.map((result) =>
      resolveRecognizedScore(record(result), rows),
    ),
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
    if (expected.dxScore !== undefined) {
      assert.equal(saved.dxScore, String(expected.dxScore));
    }
  }
});
