const DEFAULT_PROD_CDN_BASE_URL = "https://cdn.maiscorehub.bakapiano.com";

const configuredCdnBaseUrl = import.meta.env.VITE_CDN_BASE_URL?.trim();

export const CDN_BASE_URL = (
  configuredCdnBaseUrl !== undefined
    ? configuredCdnBaseUrl
    : import.meta.env.PROD
      ? DEFAULT_PROD_CDN_BASE_URL
      : ""
).replace(/\/+$/, "");

/** Build a CDN URL for static/public assets in production, staying relative in dev. */
export function cdnUrl(path: string): string {
  if (!CDN_BASE_URL || /^https?:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${CDN_BASE_URL}${normalized}`;
}
