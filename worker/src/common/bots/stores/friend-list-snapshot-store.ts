import type { FriendInfo } from "../../types.ts";

export type FriendListSnapshot = {
  friends: FriendInfo[];
  updatedAt: Date;
};

export class FriendListSnapshotStore {
  private snapshot: FriendListSnapshot | null = null;
  private changed: (() => void) | null = null;

  getSnapshot(): FriendListSnapshot | null {
    if (!this.snapshot) return null;
    return {
      friends: this.snapshot.friends.map((friend) => ({ ...friend })),
      updatedAt: new Date(this.snapshot.updatedAt),
    };
  }

  replace(friends: FriendInfo[], updatedAt = new Date()): void {
    const nextFriends = friends.map((friend) => ({ ...friend }));
    const changed = !areFriendCodeSetsEqual(
      this.snapshot?.friends ?? [],
      nextFriends,
    );
    this.snapshot = {
      friends: nextFriends,
      updatedAt,
    };
    if (changed) this.notifyChanged();
  }

  clear(): void {
    this.snapshot = null;
  }

  recordFriendRelation(friendCode: string, isFriend: boolean): void {
    if (!this.snapshot) return;
    if (isFriend) {
      this.upsertFriend({ friendCode, isFavorite: false });
    } else {
      this.removeFriend(friendCode);
    }
  }

  requestRefresh(): void {
    this.notifyChanged();
  }

  onChanged(callback: (() => void) | null): void {
    this.changed = callback;
  }

  private upsertFriend(friend: FriendInfo): void {
    if (!this.snapshot) return;
    const existingFriends = this.snapshot.friends;
    const index = existingFriends.findIndex(
      (f) => f.friendCode === friend.friendCode,
    );
    if (index >= 0) {
      this.snapshot = {
        friends: existingFriends.map((existing, i) =>
          i === index ? { ...friend, ...existing } : { ...existing },
        ),
        updatedAt: new Date(),
      };
      return;
    }

    this.snapshot = {
      friends: [
        ...existingFriends.map((existing) => ({ ...existing })),
        { ...friend },
      ],
      updatedAt: new Date(),
    };
    this.notifyChanged();
  }

  private removeFriend(friendCode: string): void {
    if (!this.snapshot) return;

    const nextFriends = this.snapshot.friends.filter(
      (friend) => friend.friendCode !== friendCode,
    );
    if (nextFriends.length === this.snapshot.friends.length) return;

    this.snapshot = {
      friends: nextFriends.map((friend) => ({ ...friend })),
      updatedAt: new Date(),
    };
    this.notifyChanged();
  }

  private notifyChanged(): void {
    this.changed?.();
  }
}

function areFriendCodeSetsEqual(
  left: FriendInfo[],
  right: FriendInfo[],
): boolean {
  if (left.length !== right.length) return false;
  const leftFriendCodes = new Set(left.map((friend) => friend.friendCode));
  return right.every((friend) => leftFriendCodes.has(friend.friendCode));
}
