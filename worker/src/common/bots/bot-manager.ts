/**
 * Bot 管理模块。
 * 一个 worker 只维护一个 Bot 的 CookieJar。
 */

import { CookieJar } from "tough-cookie";

import { MaimaiClient } from "../maimai/client.ts";
import {
  startBotBackgroundTasks,
  type StopTask,
} from "./background-tasks/index.ts";
import { FriendListSnapshotStore } from "./stores/friend-list-snapshot-store.ts";

export type ManagedBot = {
  friendCode: string;
  expired: boolean;
  client: MaimaiClient;
};

export class BotManager {
  friendCode: string | null = null;
  jar: CookieJar | null = null;
  expired = false;
  readonly friendListSnapshots = new FriendListSnapshotStore();
  private readonly stateChangedListeners = new Set<() => void>();

  getBot(): ManagedBot | null {
    if (!this.friendCode || !this.jar) {
      return null;
    }

    return {
      friendCode: this.friendCode,
      expired: this.expired,
      client: new MaimaiClient(this.jar, {
        onCookieExpired: () => this._markExpired(),
        onCookieChanged: () => this.notifyStateChanged(),
        onFriendListFetched: (friends) =>
          this.friendListSnapshots.replace(friends),
        onFriendRelationChecked: (friendCode, isFriend) =>
          this.friendListSnapshots.recordFriendRelation(friendCode, isFriend),
        onFriendListRefreshRequested: () =>
          this.friendListSnapshots.requestRefresh(),
      }),
    };
  }

  _onStateChanged(callback: (() => void) | null): void {
    this.stateChangedListeners.clear();
    if (callback) {
      this.stateChangedListeners.add(callback);
    }
  }

  onStateChanged(callback: () => void): () => void {
    this.stateChangedListeners.add(callback);
    return () => {
      this.stateChangedListeners.delete(callback);
    };
  }

  private notifyStateChanged(): void {
    for (const listener of this.stateChangedListeners) {
      listener();
    }
  }

  _set(friendCode: string, jar: CookieJar): void {
    const cookies = (jar as any).cookies?.get("maimai.wahlap.com");
    if (cookies) {
      for (const [key] of cookies) {
        const cookie = cookies.get(key);
        if (cookie) {
          cookie.expiry = new Date().setFullYear(2099);
        }
      }
    }

    if (this.friendCode && this.friendCode !== friendCode) {
      console.log(
        `[BotManager] Replacing bot cookie ${this.friendCode} with ${friendCode}`,
      );
    }
    this.friendCode = friendCode;
    this.jar = jar;
    this.expired = false;
    this.friendListSnapshots.clear();
    this.notifyStateChanged();
  }

  _markExpired(): void {
    if (!this.friendCode || !this.jar || this.expired) return;
    this.expired = true;
    this.notifyStateChanged();
    console.warn(`[BotManager] Bot ${this.friendCode} marked as expired`);
  }

  _markValid(): void {
    if (!this.friendCode || !this.jar || !this.expired) return;
    this.expired = false;
    this.notifyStateChanged();
    console.log(`[BotManager] Bot ${this.friendCode} marked as valid`);
  }
}

export const botManager = new BotManager();

let stopBackgroundTasks: StopTask[] = startBotBackgroundTasks(botManager);

export function stopBotManagerBackgroundTasks(): void {
  for (const stop of [...stopBackgroundTasks].reverse()) {
    stop();
  }
  stopBackgroundTasks = [];
}
