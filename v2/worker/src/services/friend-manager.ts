/**
 * 好友管理服务
 * 负责好友请求的发送、接受、清理等操作
 */

import { MaimaiHttpClient } from "./maimai-client.ts";

/**
 * 好友管理器
 */
export class FriendManager {
  private client: MaimaiHttpClient;

  constructor(client: MaimaiHttpClient) {
    this.client = client;
  }

  /**
   * 清理与指定用户的好友关系
   * 包括取消待处理的好友请求和删除已有好友
   */
  async cleanUpFriend(friendCode: string): Promise<void> {
    let [sent, friends] = await Promise.all([
      this.client.getSentRequests(),
      this.client.getFriendList(),
    ]);

    const sentCodes = sent.map((s) => s.friendCode);

    if (sentCodes.includes(friendCode)) {
      console.log(
        `[FriendManager] Cleanup: canceling pending request for ${friendCode}`
      );
      try {
        await this.client.cancelFriendRequest(friendCode);
      } catch (e) {
        sent = await this.client.getSentRequests();
        if (sent.map((s) => s.friendCode).includes(friendCode)) {
          throw e;
        }
      }
    }

    if (friends.includes(friendCode)) {
      console.log(`[FriendManager] Cleanup: removing friend ${friendCode}`);
      try {
        await this.client.removeFriend(friendCode);
      } catch (e) {
        friends = await this.client.getFriendList();
        if (friends.includes(friendCode)) {
          throw e;
        }
      }
    }
  }

  /**
   * 发送好友请求
   */
  async sendFriendRequest(friendCode: string): Promise<void> {
    await this.client.sendFriendRequest(friendCode);
  }

  /**
   * 检查并接受好友请求（如果对方发送了请求）
   */
  async acceptFriendRequestIfPending(friendCode: string): Promise<boolean> {
    const pending = await this.client.getAcceptRequests();
    if (pending.includes(friendCode)) {
      console.log(
        `[FriendManager] Friend request pending approval, accepting...`
      );
      await this.client.allowFriendRequest(friendCode);
      return true;
    }
    return false;
  }

  /**
   * 检查是否已经是好友
   */
  async isFriend(friendCode: string): Promise<boolean> {
    const friends = await this.client.getFriendList();
    return friends.includes(friendCode);
  }

  /**
   * 获取已发送的好友请求
   */
  async getSentRequests() {
    return this.client.getSentRequests();
  }

  /**
   * 收藏好友
   */
  async favoriteOnFriend(friendCode: string): Promise<void> {
    await this.client.favoriteOnFriend(friendCode);
  }
}
