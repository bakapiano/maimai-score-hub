/**
 * 舞萌 DX 页面请求 facade。
 * 请求生命周期在 request-executor，规则在 request-policy，运行时状态在 request-runtime。
 */

import { CookieJar } from "tough-cookie";

import { executeMaimaiPageRequest } from "./request-executor.ts";
import type {
  MaimaiPageRequest,
  MaimaiPageResponse,
} from "./request-policy.ts";

export type {
  MaimaiPageRequest,
  MaimaiPageResponse,
} from "./request-policy.ts";

export class MaimaiHttpClient {
  private cookieJar: CookieJar;
  private readonly onCookieExpired?: () => void;
  private readonly onCookieChanged?: () => void;

  constructor(
    cookieJar: CookieJar,
    options: {
      onCookieExpired?: () => void;
      onCookieChanged?: () => void;
    } = {},
  ) {
    this.cookieJar = cookieJar;
    this.onCookieExpired = options.onCookieExpired;
    this.onCookieChanged = options.onCookieChanged;
  }

  async requestPage(request: MaimaiPageRequest): Promise<MaimaiPageResponse> {
    return executeMaimaiPageRequest({
      cookieJar: this.cookieJar,
      request,
      onCookieExpired: this.onCookieExpired,
      onCookieChanged: this.onCookieChanged,
    });
  }
}
