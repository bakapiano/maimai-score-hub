/**
 * 舞萌好友相关页面 API。
 */

import { MAIMAI_URLS } from "./constants.ts";
import type {
  AcceptFriendRequest,
  FriendRecentEvent,
  FriendInfo,
  SentFriendRequest,
} from "../types.ts";
import {
  parseFriendCount,
  parseFriendList,
} from "./parsers/friend-list-parser.ts";
import { parseFriendRecentEvents } from "./parsers/friend-recent-event-parser.ts";
import {
  parseAcceptRequests,
  parseHasReceivedFriendRequest,
  parseHasSentFriendRequest,
  parseIsFriendFromSearchPage,
  parseSentRequests,
} from "./parsers/friend-request-parser.ts";
import type { MaimaiHttpClient } from "./infra/http-client.ts";

export interface MaimaiFriendApiOptions {
  onFriendListFetched?: (friends: FriendInfo[]) => void;
  onFriendRelationChecked?: (
    friendCode: string,
    isFriend: boolean,
  ) => void;
  onFriendListRefreshRequested?: () => void;
}

export class MaimaiFriendApi {
  private static readonly cleanUpPromises = new Map<string, Promise<void>>();
  private static readonly cleanupTimeoutMs = 60_000;
  private readonly http: MaimaiHttpClient;
  private readonly options: MaimaiFriendApiOptions;

  constructor(
    http: MaimaiHttpClient,
    options: MaimaiFriendApiOptions = {},
  ) {
    this.http = http;
    this.options = options;
  }

  /**
   * 获取完整好友列表（自动翻页）
   * 第一页返回最多 10 个好友，通过好友数计算总页数后逐页获取
   */
  async getFriendList(opts?: { maxPages?: number }): Promise<FriendInfo[]> {
    console.log(`[MaimaiClient] Start get friend list`);

    const firstPage = await this.http.requestPage({
      url: MAIMAI_URLS.friendList,
    });
    const firstText = firstPage.body;
    const friends = parseFriendList(firstText);
    const friendCount = parseFriendCount(firstText);

    if (friendCount === null || friendCount <= 10) {
      console.log(
        `[MaimaiClient] Done get friend list (single page), count=${friends.length}`,
      );
      this.recordFriendList(friends);
      return friends;
    }

    const naturalTotalPages = Math.ceil(friendCount / 10) + 1;
    const totalPages = opts?.maxPages
      ? Math.min(naturalTotalPages, Math.max(1, opts.maxPages))
      : naturalTotalPages;
    console.log(
      `[MaimaiClient] Friend count: ${friendCount}, fetching pages 2..${totalPages}${
        opts?.maxPages && totalPages < naturalTotalPages
          ? ` (capped at maxPages=${opts.maxPages}, would be ${naturalTotalPages})`
          : ""
      }`,
    );

    for (let page = 2; page <= totalPages; page++) {
      const pageResult = await this.http.requestPage({
        url: MAIMAI_URLS.friendListPage(page),
      });
      const pageText = pageResult.body;
      const pageFriends = parseFriendList(pageText);
      friends.push(...pageFriends);
    }

    const seen = new Set<string>();
    const uniqueFriends = friends.filter((f) => {
      if (seen.has(f.friendCode)) return false;
      seen.add(f.friendCode);
      return true;
    });
    console.log(
      `[MaimaiClient] Done get friend list (${totalPages} pages), count=${uniqueFriends.length}`,
    );
    if (totalPages === naturalTotalPages) {
      this.recordFriendList(uniqueFriends);
    }
    return uniqueFriends;
  }

  private recordFriendList(friends: FriendInfo[]): void {
    try {
      this.options.onFriendListFetched?.(friends);
    } catch (err) {
      console.warn("[MaimaiClient] Failed to record friend list:", err);
    }
  }

  private recordFriendRelation(
    friendCode: string,
    isFriend: boolean,
  ): void {
    try {
      this.options.onFriendRelationChecked?.(friendCode, isFriend);
    } catch (err) {
      console.warn("[MaimaiClient] Failed to record friend relation:", err);
    }
  }

  private requestFriendListRefresh(): void {
    try {
      this.options.onFriendListRefreshRequested?.();
    } catch (err) {
      console.warn("[MaimaiClient] Failed to request friend list refresh:", err);
    }
  }

  async getSentRequests(): Promise<SentFriendRequest[]> {
    console.log(`[MaimaiClient] Start get sent friend requests`);
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.friendInvite,
    });
    const text = result.body;
    const requests = parseSentRequests(text);
    console.log(`[MaimaiClient] Done get sent friend requests`);
    return requests;
  }

  async getAcceptRequests(): Promise<AcceptFriendRequest[]> {
    console.log(`[MaimaiClient] Start get accept friend requests`);
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.friendAccept,
    });
    const text = result.body;
    const ids = parseAcceptRequests(text);
    console.log(`[MaimaiClient] Done get accept friend requests:`, ids);
    return ids;
  }

  async hasReceivedFriendRequest(friendCode: string): Promise<boolean> {
    console.log(
      `[MaimaiClient] Start verify received friend request, friend code ${friendCode}`,
    );
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.friendSearch(friendCode),
    });
    const hasRequest = parseHasReceivedFriendRequest(result.body);
    console.log(
      `[MaimaiClient] Done verify received friend request, friend code ${friendCode}: ${hasRequest}`,
    );
    return hasRequest;
  }

  async hasSentFriendRequest(friendCode: string): Promise<boolean> {
    console.log(
      `[MaimaiClient] Start verify sent friend request, friend code ${friendCode}`,
    );
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.friendSearch(friendCode),
    });
    const hasRequest = parseHasSentFriendRequest(result.body);
    console.log(
      `[MaimaiClient] Done verify sent friend request, friend code ${friendCode}: ${hasRequest}`,
    );
    return hasRequest;
  }

  async isFriendBySearchPage(friendCode: string): Promise<boolean> {
    console.log(
      `[MaimaiClient] Start verify friend relation by search page, friend code ${friendCode}`,
    );
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.friendSearch(friendCode),
    });
    const isFriend = parseIsFriendFromSearchPage(result.body);
    this.recordFriendRelation(friendCode, isFriend);
    console.log(
      `[MaimaiClient] Done verify friend relation by search page, friend code ${friendCode}: ${isFriend}`,
    );
    return isFriend;
  }

  async sendFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start send friend request, friend code ${friendCode}`,
    );
    await this.http.requestPage({
      url: MAIMAI_URLS.friendSearchInvite,
      formBodyWithToken: `idx=${friendCode}&invite=`,
    });

    await this.http.requestPage({
      url: MAIMAI_URLS.friendInvite,
    });
    this.recordFriendRelation(friendCode, false);
    console.log(
      `[MaimaiClient] Done send friend request, friend code ${friendCode}`,
    );
  }

  async allowFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start allow friend request, friend code ${friendCode}`,
    );
    await this.http.requestPage({
      url: MAIMAI_URLS.friendAcceptAllow,
      formBodyWithToken: `idx=${friendCode}&allow=`,
    });

    await this.http.requestPage({
      url: MAIMAI_URLS.friendAcceptAllow,
    });
    this.recordFriendRelation(friendCode, true);
    this.requestFriendListRefresh();
    console.log(
      `[MaimaiClient] Done allow friend request, friend code ${friendCode}`,
    );
  }

  async blockFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start block friend request, friend code ${friendCode}`,
    );
    await this.http.requestPage({
      url: MAIMAI_URLS.friendAcceptBlock,
      formBodyWithToken: `idx=${friendCode}&block=`,
    });

    await this.http.requestPage({
      url: MAIMAI_URLS.friendAccept,
    });
    this.recordFriendRelation(friendCode, false);
    console.log(
      `[MaimaiClient] Done block friend request, friend code ${friendCode}`,
    );
  }

  async cancelFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start cancel friend request, friend code ${friendCode}`,
    );
    await this.http.requestPage({
      url: MAIMAI_URLS.friendInviteCancel,
      formBodyWithToken: `idx=${friendCode}&invite=`,
    });
    this.recordFriendRelation(friendCode, false);
    console.log(
      `[MaimaiClient] Done cancel friend request, friend code ${friendCode}`,
    );
  }

  async removeFriend(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start remove friend, friend code ${friendCode}`,
    );
    await this.http.requestPage({
      url: MAIMAI_URLS.friendDetail,
      formBodyWithToken: `idx=${friendCode}`,
    });
    this.recordFriendRelation(friendCode, false);
    this.requestFriendListRefresh();
    console.log(`[MaimaiClient] Done remove friend, friend code ${friendCode}`);
  }

  /**
   * 清理与指定用户的好友关系，包括取消待处理请求、拒绝待接受请求和删除好友。
   */
  async cleanUpFriend(friendCode: string): Promise<void> {
    const existing = MaimaiFriendApi.cleanUpPromises.get(friendCode);
    if (existing) {
      return existing;
    }

    const promise = this.doCleanUpFriend(friendCode);
    MaimaiFriendApi.cleanUpPromises.set(friendCode, promise);

    const timeout = setTimeout(() => {
      MaimaiFriendApi.cleanUpPromises.delete(friendCode);
    }, MaimaiFriendApi.cleanupTimeoutMs);

    return promise.finally(() => {
      clearTimeout(timeout);
      MaimaiFriendApi.cleanUpPromises.delete(friendCode);
    });
  }

  async acceptFriendRequestIfPending(friendCode: string): Promise<boolean> {
    if (await this.hasReceivedFriendRequest(friendCode)) {
      console.log(`[MaimaiClient] Friend request pending approval, accepting`);
      await this.allowFriendRequest(friendCode);
      return true;
    }
    return false;
  }

  async isFriend(friendCode: string): Promise<boolean> {
    return this.isFriendBySearchPage(friendCode);
  }

  async getFriendRecentEvents(friendCode: string): Promise<FriendRecentEvent[]> {
    console.log(
      `[MaimaiClient] Start get friend recent events, friend code ${friendCode}`,
    );
    const result = await this.http.requestPage({
      url: MAIMAI_URLS.friendDetailPage(friendCode),
    });
    const text = result.body;
    const events = parseFriendRecentEvents(text);
    console.log(
      `[MaimaiClient] Done get friend recent events, friend code ${friendCode}, count=${events.length}`,
    );
    return events;
  }

  private async doCleanUpFriend(friendCode: string): Promise<void> {
    if (await this.hasReceivedFriendRequest(friendCode)) {
      console.log(
        `[MaimaiClient] Cleanup: declining accepted request for ${friendCode}`,
      );
      try {
        await this.blockFriendRequest(friendCode);
      } catch (e) {
        if (await this.hasReceivedFriendRequest(friendCode)) {
          throw e;
        }
      }
    }

    if (await this.hasSentFriendRequest(friendCode)) {
      console.log(
        `[MaimaiClient] Cleanup: canceling pending request for ${friendCode}`,
      );
      try {
        await this.cancelFriendRequest(friendCode);
      } catch (e) {
        if (await this.hasSentFriendRequest(friendCode)) {
          throw e;
        }
      }
    }

    if (await this.isFriendBySearchPage(friendCode)) {
      console.log(`[MaimaiClient] Cleanup: removing friend ${friendCode}`);
      try {
        await this.removeFriend(friendCode);
      } catch (e) {
        if (await this.isFriendBySearchPage(friendCode)) {
          throw e;
        }
      }
    }
  }
}
