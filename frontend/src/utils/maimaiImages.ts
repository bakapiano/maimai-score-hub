import { cdnUrl } from "../api/cdnUrl";

const MAIMAI_IMG_PREFIX = "https://maimai.wahlap.com/maimai-mobile/img/";

export function normalizeMaimaiImgUrl(url: string) {
  if (url.startsWith(MAIMAI_IMG_PREFIX)) {
    return cdnUrl(url.replace(MAIMAI_IMG_PREFIX, "/maimai-mobile/img/"));
  }
  if (url.startsWith("/maimai-mobile/img/")) {
    return cdnUrl(url);
  }
  return url;
}
