/**
 * 舞萌用户资料相关页面 API。
 */

import { MAIMAI_URLS } from "./constants.ts";
import type { UserProfile } from "../types.ts";
import {
  parseUserFriendCode,
  parseUserProfile,
} from "./parsers/user-profile-parser.ts";
import type { MaimaiHttpClient } from "./infra/http-client.ts";

export class MaimaiProfileApi {
  private readonly http: MaimaiHttpClient;

  constructor(http: MaimaiHttpClient) {
    this.http = http;
  }

  async getUserProfile(friendCode: string): Promise<UserProfile | null> {
    console.log(
      `[MaimaiClient] Start get user profile by friend code ${friendCode}`,
    );
    const url = MAIMAI_URLS.friendSearch(friendCode);
    const result = await this.http.requestPage({ url });
    const text = result.body;
    const profile = parseUserProfile(text);
    console.log(
      `[MaimaiClient] Done get user profile by friend code ${friendCode}`,
    );
    return profile;
  }

  async getUserFriendCode(): Promise<string | null> {
    console.log(`[MaimaiClient] Start get user friend code`);
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.userFriendCode,
    });
    const text = result.body;
    const friendCode = parseUserFriendCode(text);
    console.log(`[MaimaiClient] Done get user friend code: ${friendCode}`);
    return friendCode;
  }
}
