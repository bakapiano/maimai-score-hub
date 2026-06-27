/**
 * 舞萌 DX 客户端入口。
 * 底层请求能力和页面 API 分在相邻文件里，这里只做装配。
 */

import { CookieJar } from "tough-cookie";

import { MaimaiFriendApi } from "./friend-api.ts";
import { MaimaiHttpClient } from "./infra/http-client.ts";
import { MaimaiProfileApi } from "./profile-api.ts";
import { MaimaiScoreApi } from "./score-api.ts";
import { MaimaiSessionApi } from "./session-api.ts";
import type { FriendInfo } from "../types.ts";

export interface MaimaiClientOptions {
  onFriendListFetched?: (friends: FriendInfo[]) => void;
  onFriendRelationChecked?: (
    friendCode: string,
    isFriend: boolean,
  ) => void;
  onFriendListRefreshRequested?: () => void;
  onCookieExpired?: () => void;
  onCookieChanged?: () => void;
}

export class MaimaiClient {
  private readonly http: MaimaiHttpClient;
  readonly friends: MaimaiFriendApi;
  readonly profiles: MaimaiProfileApi;
  readonly scores: MaimaiScoreApi;
  readonly sessions: MaimaiSessionApi;

  constructor(cookieJar: CookieJar, options: MaimaiClientOptions = {}) {
    this.http = new MaimaiHttpClient(cookieJar, {
      onCookieExpired: options.onCookieExpired,
      onCookieChanged: options.onCookieChanged,
    });
    this.friends = new MaimaiFriendApi(this.http, {
      onFriendListFetched: options.onFriendListFetched,
      onFriendRelationChecked: options.onFriendRelationChecked,
      onFriendListRefreshRequested: options.onFriendListRefreshRequested,
    });
    this.profiles = new MaimaiProfileApi(this.http);
    this.scores = new MaimaiScoreApi(this.http);
    this.sessions = new MaimaiSessionApi(this.http);
  }
}
