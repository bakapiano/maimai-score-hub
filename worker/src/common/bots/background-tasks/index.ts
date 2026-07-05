import type { BotManager } from "../bot-manager.ts";
import {
  bindBotSaveScheduler,
  createBotPeriodicSaveTask,
  loadPersistedBot,
} from "./persistence-cookie.ts";
import { createCleanupFriendsTask } from "./cleanup-friends.ts";
import {
  bindBotStatusChangeReportScheduler,
  createBotFriendListRefreshTask,
  createBotStatusReportTask,
} from "./status-report.ts";
import { createHealthCheckTask } from "./health-check.ts";

export type StopTask = () => void;

export type PeriodicTask = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  runImmediately?: boolean;
  shouldSkip?: () => boolean;
};

export function startBotBackgroundTasks(manager: BotManager): StopTask[] {
  loadPersistedBot(manager);

  const periodicTasks = [
    createBotPeriodicSaveTask(manager),
    createHealthCheckTask(manager),
    createBotStatusReportTask(manager),
    createBotFriendListRefreshTask(manager),
    createCleanupFriendsTask(manager),
  ].map(startPeriodicTask);

  return [
    bindBotSaveScheduler(manager),
    bindBotStatusChangeReportScheduler(manager),
    ...periodicTasks,
  ];
}

function startPeriodicTask(task: PeriodicTask): StopTask {
  let running = false;

  const run = (): void => {
    if (task.shouldSkip?.()) {
      return;
    }

    if (running) {
      console.log(`[${task.name}] Previous run still in progress, skipping`);
      return;
    }

    running = true;
    task
      .run()
      .catch((err) => {
        console.error(`[${task.name}] Failed:`, err);
      })
      .finally(() => {
        running = false;
      });
  };

  if (task.runImmediately) {
    run();
  }

  const intervalId = setInterval(run, task.intervalMs);
  console.log(`[${task.name}] Started (interval: ${task.intervalMs}ms)`);

  return () => {
    clearInterval(intervalId);
    console.log(`[${task.name}] Stopped`);
  };
}
