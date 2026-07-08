import { syncApi, usersApi } from "../api/appClient";

import { fetchLatestSync } from "../api/syncLatest";

type JsonResult<T> = {
  ok: boolean;
  status: number;
  data: T;
};

function getAuthorization(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  return headers.get("Authorization") ?? headers.get("authorization") ?? "";
}

function parseBody(init?: RequestInit) {
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

function toResult<T>(status: number, ok: boolean, body: unknown): JsonResult<T> {
  return {
    ok,
    status,
    data: (body ?? null) as T,
  };
}

async function handleProfileRequest<T>(
  method: string,
  authorization: string,
  init?: RequestInit,
) {
  if (method === "GET") {
    const res = await usersApi.profile({ headers: { authorization } });
    return toResult<T>(res.status, res.status === 200, res.body);
  }

  const body = parseBody(init);
  const patchBody: Record<string, string | boolean | null> = {};
  if ("divingFishImportToken" in body) {
    patchBody.divingFishImportToken =
      (body.divingFishImportToken as string | null) ?? null;
  }
  if ("lxnsImportToken" in body) {
    patchBody.lxnsImportToken = (body.lxnsImportToken as string | null) ?? null;
  }
  const res = await usersApi.updateProfile({
    headers: { authorization },
    body: patchBody,
  });
  return toResult<T>(res.status, res.status === 200, res.body);
}

async function handleDivingFishTokenRequest<T>(
  authorization: string,
  init?: RequestInit,
) {
  const body = init?.body
    ? (JSON.parse(String(init.body)) as { username: string; password: string })
    : { username: "", password: "" };
  const res = await usersApi.getDivingFishToken({
    headers: { authorization },
    body,
  });
  return toResult<T>(res.status, res.status === 201, res.body);
}

async function handleProviderExport<T>(
  target: "diving-fish" | "lxns",
  authorization: string,
) {
  const res =
    target === "diving-fish"
      ? await syncApi.exportToDivingFish({ headers: { authorization } })
      : await syncApi.exportToLxns({ headers: { authorization } });
  return toResult<T>(res.status, res.status === 201, res.body);
}

async function handleExportJob<T>(path: string, authorization: string) {
  const exportJobMatch = path.match(
    /^\/api\/v1\/me\/sync\/prober-export-jobs\/([^/]+)$/,
  );
  if (!exportJobMatch) {
    return null;
  }
  const res = await syncApi.getProberExportJob({
    headers: { authorization },
    params: { exportJobId: decodeURIComponent(exportJobMatch[1]) },
  });
  return toResult<T>(res.status, res.status === 200, res.body);
}

async function fetchFallback<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}

export async function fetchSyncPageJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const path = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const authorization = getAuthorization(init);

  if (path === "/api/v1/me" && authorization) {
    return handleProfileRequest<T>(method, authorization, init);
  }
  if (
    path === "/api/v1/me/prober-tokens/diving-fish" &&
    method === "POST" &&
    authorization
  ) {
    return handleDivingFishTokenRequest<T>(authorization, init);
  }
  if (path === "/api/v1/me/sync/latest" && method === "GET" && authorization) {
    return fetchLatestSync<T>(authorization.replace(/^Bearer\s+/i, ""));
  }
  if (
    path === "/api/v1/me/sync/latest/exports/diving-fish" &&
    method === "POST" &&
    authorization
  ) {
    return handleProviderExport<T>("diving-fish", authorization);
  }
  if (
    path === "/api/v1/me/sync/latest/exports/lxns" &&
    method === "POST" &&
    authorization
  ) {
    return handleProviderExport<T>("lxns", authorization);
  }

  return (
    (await handleExportJob<T>(path, authorization)) ??
    (await fetchFallback<T>(input, init))
  );
}
