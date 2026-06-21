/**
 * 舞萌会话相关页面 API。
 */

import { MAIMAI_URLS } from "./constants.ts";
import type { MaimaiHttpClient } from "./infra/http-client.ts";

export class MaimaiSessionApi {
  private readonly http: MaimaiHttpClient;

  constructor(http: MaimaiHttpClient) {
    this.http = http;
  }

  async verifySession(): Promise<void> {
    await this.http.requestPage({
      url: MAIMAI_URLS.home,
    });
  }
}
