const API_V1_PATH = "/api/v1";

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

export const API_BASE_URL = (configuredApiBaseUrl || API_V1_PATH).replace(
  /\/+$/,
  "",
);

/** Build an API v1 URL using the same-origin /api/v1 prefix by default. */
export function apiUrl(path = ""): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const withoutApiPrefix = path.replace(/^\/?api\/v1(?=\/|$)/, "");
  if (!withoutApiPrefix) {
    return API_BASE_URL;
  }
  return `${API_BASE_URL}${withoutApiPrefix.startsWith("/") ? "" : "/"}${withoutApiPrefix}`;
}

/** Normalize relative or absolute API inputs for route matching. */
export function getApiPath(input: RequestInfo | URL): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof Request
        ? input.url
        : input.toString();

  try {
    return new URL(raw, "https://local.invalid").pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}
