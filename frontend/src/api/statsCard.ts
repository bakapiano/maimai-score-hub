import { StatsCardStateSchema } from "@maimai-score-hub/shared";
import type {
  StatsCardTheme,
  StatsCardDisplayPatch,
} from "@maimai-score-hub/shared";
import { apiUrl } from "./baseUrl";

export type StatsCardAction = "enable" | "rotate" | "disable";
export async function getStatsCardState(token: string, signal?: AbortSignal) {
  return stateRequest(token, "", "GET", signal);
}
export async function changeStatsCard(token: string, action: StatsCardAction) {
  return stateRequest(
    token,
    action === "rotate" ? "/rotate" : "",
    action === "disable" ? "DELETE" : "POST",
  );
}
export async function updateStatsCardDisplay(
  token: string,
  display: StatsCardDisplayPatch,
) {
  return stateRequest(token, "", "PATCH", undefined, display);
}
async function stateRequest(
  token: string,
  suffix: string,
  method: string,
  signal?: AbortSignal,
  body?: StatsCardDisplayPatch,
) {
  const response = await fetch(apiUrl("/me/stats-card" + suffix), {
    method,
    signal,
    cache: "no-store",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(method === "POST" || method === "PATCH"
      ? { body: JSON.stringify(body ?? {}) }
      : {}),
  });
  if (!response.ok) {
    throw new Error(errorMessage(response.status));
  }
  return StatsCardStateSchema.parse(await response.json());
}
export async function getStatsCardPreview(
  token: string,
  theme: StatsCardTheme,
  signal: AbortSignal,
) {
  const response = await fetch(
    apiUrl("/me/stats-card/preview.svg?theme=" + theme),
    {
      signal,
      cache: "no-store",
      headers: { Authorization: "Bearer " + token },
    },
  );
  if (!response.ok) {
    throw new Error(errorMessage(response.status));
  }
  if (!response.headers.get("content-type")?.includes("image/svg+xml")) {
    throw new Error("预览返回了无效的图片，请稍后重试");
  }
  return response.blob();
}
function errorMessage(status: number) {
  if (status === 401) {
    return "登录已过期，请重新登录";
  }
  if (status === 429 || status === 503) {
    return "卡片服务繁忙，请稍后重试";
  }
  return "操作未完成，请检查网络后重试";
}

export function statsCardLink(
  origin: string,
  code: string,
  theme: StatsCardTheme,
) {
  return (
    origin.replace(/\/$/, "") + "/stats/" + code + "/card.svg?theme=" + theme
  );
}
