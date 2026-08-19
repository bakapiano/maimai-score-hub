import assert from "node:assert/strict";
import test from "node:test";

import { MaimaiScoreApi } from "../common/maimai/score-api.ts";
import {
  CookieExpiredError,
  MaimaiRateLimitedError,
  NonRetryableError,
} from "../common/maimai/infra/errors.ts";
import type { MaimaiHttpClient } from "../common/maimai/infra/http-client.ts";
import type { MaimaiPageRequest } from "../common/maimai/infra/request-policy.ts";

type RequestPage = MaimaiHttpClient["requestPage"];

test("uses the full Friend VS page when it succeeds", async () => {
  const urls: string[] = [];
  const api = createApi(async (request) => {
    urls.push(request.url);
    return page(request, friendVsHtml("full-song"));
  });

  const songs = await api.getFriendVS("123", 2, 3);

  assert.equal(songs.length, 1);
  assert.deepEqual(urls.map(genreFromUrl), [99]);
});

test("falls back to six sequential genre pages after a terminated request", async () => {
  const urls: string[] = [];
  const retryCounts = new Map<number, number>();
  const api = createApi(async (request) => {
    urls.push(request.url);
    const genre = genreFromUrl(request.url);
    retryCounts.set(genre, request.policy?.retryCount ?? 0);
    if (genre === 99) {
      throw new TypeError("terminated", {
        cause: Object.assign(new Error("socket closed"), {
          code: "ECONNRESET",
        }),
      });
    }
    return page(request, friendVsHtml(`genre-${genre}`));
  });

  const songs = await api.getFriendVS("123", 2, 3, "lose");

  assert.deepEqual(urls.map(genreFromUrl), [99, 101, 102, 103, 104, 105, 106]);
  assert.deepEqual(
    songs.map((song) => song.name),
    [101, 102, 103, 104, 105, 106].map((genre) => `genre-${genre}`),
  );
  assert.ok(urls.every((url) => url.includes("loseOnly=on")));
  assert.deepEqual(
    [99, 101, 102, 103, 104, 105, 106].map((genre) => retryCounts.get(genre)),
    [2, 2, 2, 2, 2, 2, 2],
  );
});

test("splits large genre pages into win, lose, and tie during all-page fallback", async () => {
  const urls: string[] = [];
  const api = createApi(async (request) => {
    urls.push(request.url);
    const genre = genreFromUrl(request.url);
    if (genre === 99) {
      throw new TypeError("terminated");
    }
    return page(
      request,
      friendVsHtml(`genre-${genre}-${sideFromUrl(request.url)}`),
    );
  });

  const songs = await api.getFriendVS("123", 2, 3);

  assert.deepEqual(
    urls.map(genreFromUrl),
    [99, 101, 102, 102, 102, 103, 104, 105, 105, 105, 106],
  );
  assert.deepEqual(urls.map(sideFromUrl), [
    "all",
    "all",
    "win",
    "lose",
    "tie",
    "all",
    "all",
    "win",
    "lose",
    "tie",
    "all",
  ]);
  assert.deepEqual(
    songs.map((song) => song.name),
    [
      "genre-101-all",
      "genre-102-win",
      "genre-102-lose",
      "genre-102-tie",
      "genre-103-all",
      "genre-104-all",
      "genre-105-win",
      "genre-105-lose",
      "genre-105-tie",
      "genre-106-all",
    ],
  );
});

test("a planner-selected large genre remains a single all-page request", async () => {
  const urls: string[] = [];
  const api = createApi(async (request) => {
    urls.push(request.url);
    return page(request, friendVsHtml("planned-genre-102"));
  });

  const songs = await api.getFriendVsGenre("123", 2, 3, 102);

  assert.equal(songs[0]?.name, "planned-genre-102");
  assert.deepEqual(urls.map(genreFromUrl), [102]);
  assert.deepEqual(urls.map(sideFromUrl), ["all"]);
});

test("falls back after the worker timeout error", async () => {
  const urls: string[] = [];
  const api = createApi(async (request) => {
    urls.push(request.url);
    const genre = genreFromUrl(request.url);
    if (genre === 99) {
      throw new Error("请求超时, 超时时间: 90 秒");
    }
    return page(request, friendVsHtml(`genre-${genre}`));
  });

  const songs = await api.getFriendVS("123", 1, 0);

  assert.equal(songs.length, 10);
  assert.deepEqual(
    urls.map(genreFromUrl),
    [99, 101, 102, 102, 102, 103, 104, 105, 105, 105, 106],
  );
});

test("preserves permanent, auth, and UTAGE failures", async (t) => {
  const cases: Array<{ name: string; error: Error; diff: number }> = [
    {
      name: "non-retryable",
      error: new NonRetryableError("friend relation missing"),
      diff: 3,
    },
    { name: "cookie", error: new CookieExpiredError(), diff: 3 },
    { name: "rate-limit", error: new MaimaiRateLimitedError(), diff: 3 },
    { name: "utage", error: new Error("terminated"), diff: 10 },
  ];

  for (const input of cases) {
    await t.test(input.name, async () => {
      let calls = 0;
      const api = createApi(async () => {
        calls++;
        throw input.error;
      });

      await assert.rejects(
        () => api.getFriendVS("123", 2, input.diff),
        input.error,
      );
      assert.equal(calls, 1);
    });
  }
});

function createApi(requestPage: RequestPage): MaimaiScoreApi {
  return new MaimaiScoreApi({ requestPage } as MaimaiHttpClient);
}

function genreFromUrl(url: string): number {
  return Number(new URL(url).searchParams.get("genre"));
}

function sideFromUrl(url: string): "all" | "win" | "lose" | "tie" {
  const params = new URL(url).searchParams;
  const win = params.has("winOnly");
  const lose = params.has("loseOnly");
  if (win && lose) return "tie";
  if (win) return "win";
  if (lose) return "lose";
  return "all";
}

function page(request: MaimaiPageRequest, body: string) {
  request.policy?.assertBody?.(body);
  return {
    url: request.url,
    finalUrl: request.url,
    status: 200,
    body,
    response: new Response(body, { status: 200 }),
  };
}

function friendVsHtml(name: string): string {
  return `
    <div class="friend_vs_block"></div>
    <div class="screw_block">舞萌</div>
    <div class="music_master_score_back">
      <div class="music_lv_block">14</div>
      <div class="music_name_block">${name}</div>
      <table>
        <tr>
          <td class="p_r master_score_label w_120 f_b">100.0000%</td>
          <td class="p_r master_score_label w_120 f_b">99.0000%</td>
        </tr>
      </table>
    </div>
  `;
}
