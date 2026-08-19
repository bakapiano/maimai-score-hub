import assert from "node:assert/strict";
import test from "node:test";

import { MaimaiScoreApi } from "../common/maimai/score-api.ts";
import { NonRetryableError } from "../common/maimai/infra/errors.ts";
import type { MaimaiHttpClient } from "../common/maimai/infra/http-client.ts";
import type { MaimaiPageRequest } from "../common/maimai/infra/request-policy.ts";

type RequestPage = MaimaiHttpClient["requestPage"];

test("levels 12+, 13, and 13+ immediately split on the first transport failure", async () => {
  const cases = [
    { level: 18, error: new TypeError("terminated") },
    {
      level: 19,
      error: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    },
    { level: 20, error: new Error("请求超时, 超时时间: 90 秒") },
  ];
  for (const { level, error } of cases) {
    const requests: MaimaiPageRequest[] = [];
    const api = createApi(async (request) => {
      requests.push(request);
      const side = sideFromUrl(request.url);
      if (side === "all") {
        throw error;
      }
      return page(request, friendVsHtml(`level-${level}-${side}`));
    });

    const songs = await api.getFriendVsLevel("123", 2, level);

    assert.deepEqual(
      requests.map((request) => sideFromUrl(request.url)),
      ["all", "win", "lose", "tie"],
    );
    assert.deepEqual(
      requests.map((request) => request.policy?.retryCount),
      [1, 2, 2, 2],
    );
    assert.deepEqual(
      songs.map((song) => song.name),
      ["win", "lose", "tie"].map((side) => `level-${level}-${side}`),
    );
  }
});

test("a successful large level page stays on its first all request", async () => {
  const requests: MaimaiPageRequest[] = [];
  const api = createApi(async (request) => {
    requests.push(request);
    return page(request, friendVsHtml("level-19-all"));
  });

  const songs = await api.getFriendVsLevel("123", 2, 19);

  assert.equal(songs[0]?.name, "level-19-all");
  assert.deepEqual(
    requests.map((request) => sideFromUrl(request.url)),
    ["all"],
  );
  assert.equal(requests[0]?.policy?.retryCount, 1);
});

test("other levels retain their normal request policy", async () => {
  const requests: MaimaiPageRequest[] = [];
  const error = new TypeError("terminated");
  const api = createApi(async (request) => {
    requests.push(request);
    throw error;
  });

  await assert.rejects(() => api.getFriendVsLevel("123", 2, 17), error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.policy?.retryCount, 2);
});

test("large level pages preserve permanent failures", async () => {
  const requests: MaimaiPageRequest[] = [];
  const error = new NonRetryableError("friend relation missing");
  const api = createApi(async (request) => {
    requests.push(request);
    throw error;
  });

  await assert.rejects(() => api.getFriendVsLevel("123", 2, 18), error);
  assert.equal(requests.length, 1);
});

function createApi(requestPage: RequestPage): MaimaiScoreApi {
  return new MaimaiScoreApi({ requestPage } as MaimaiHttpClient);
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
