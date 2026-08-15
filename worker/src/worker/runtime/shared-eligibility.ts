import { botManager } from "../../common/bots/bot-manager.ts";
import { runCleanup } from "../../common/bots/background-tasks/cleanup-friends.ts";
import {
  refreshBotFriendList,
  reportBotSnapshot,
} from "../../common/bots/background-tasks/status-report.ts";
import { runWithRequestContext } from "../../common/maimai/infra/request-runtime.ts";
import type { Job } from "../../common/types.ts";
import type { SharedQueueControl } from "./queue-fleet.ts";

export class SharedEligibility {
  private readonly queues: SharedQueueControl;
  private currentCheck: Promise<void> | null = null;

  constructor(queues: SharedQueueControl) {
    this.queues = queues;
  }

  async ensureEligible(job: Job, signal: AbortSignal): Promise<void> {
    if (!this.currentCheck) {
      this.currentCheck = runWithRequestContext(
        { requestPriority: job.priority ?? 0, signal },
        async () => {
          await this.queues.pauseShared();
          try {
            let snapshot = botManager.friendListSnapshots.getSnapshot();
            if (
              !snapshot ||
              Date.now() - snapshot.updatedAt.getTime() > 5 * 60_000
            ) {
              await refreshBotFriendList(botManager);
              snapshot = botManager.friendListSnapshots.getSnapshot();
            }
            if (!snapshot) throw new LocalEligibilityError();
            if (snapshot.friends.length >= 50) {
              await runCleanup(botManager);
              botManager.friendListSnapshots.requestRefresh();
              await refreshBotFriendList(botManager);
              snapshot = botManager.friendListSnapshots.getSnapshot();
            }
            if (!snapshot || snapshot.friends.length >= 50) {
              throw new LocalEligibilityError();
            }
            await reportBotSnapshot(botManager);
          } finally {
            await this.queues.resumeShared();
          }
        },
      ).finally(() => {
        this.currentCheck = null;
      });
    }

    try {
      await this.currentCheck;
    } catch (error) {
      if (error instanceof LocalEligibilityError) throw error;
      signal.throwIfAborted();
      throw new LocalEligibilityError();
    }
  }
}

export class LocalEligibilityError extends Error {
  constructor() {
    super("Bot snapshot/capacity is not eligible for shared claim");
    this.name = "LocalEligibilityError";
  }
}
