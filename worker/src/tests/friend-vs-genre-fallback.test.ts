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
    [99, 101, 102, 103, 104, 105, 106].map((genre) =>
      retryCounts.get(genre),
    ),
    [2, 2, 3, 2, 2, 3, 2],
  );
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

  assert.equal(songs.length, 6);
  assert.deepEqual(urls.map(genreFromUrl), [99, 101, 102, 103, 104, 105, 106]);
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

      await assert.rejects(() => api.getFriendVS("123", 2, input.diff), input.error);
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
