import * as schedule from "node-schedule";

import {
  WorkerData,
  acceptFriendWork,
  cleanUpAcceptWork,
  cleanUpFriendWork,
  cleanUpLongQueueTaskWork,
  cleanUpSentRequestWork,
  cookieRefreshWork,
  prepareWork,
  sendFriendRequestWork,
  startUpdateWork,
} from "./work.js";

var data: WorkerData | undefined = undefined;

function configureBot() {
  console.log("Start configure bot...")
  
  // Clean up per 3 mins
  const cleanUp = new schedule.RecurrenceRule();
  cleanUp.minute = [
    0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57,
  ];
  schedule.scheduleJob(cleanUp, () => {
    data && [
      cleanUpAcceptWork(data),
      cleanUpFriendWork(data),
      cleanUpSentRequestWork(data),
      cleanUpLongQueueTaskWork(data),
    ];
  });

  // Cookie refresh per 15 seconds
  let cookieRefreshLock = false
  const cookieRefresh = new schedule.RecurrenceRule();
  cookieRefresh.second = [0, 15, 30, 45];
  schedule.scheduleJob(cookieRefresh, async () => {
    if (cookieRefreshLock) return;
    cookieRefreshLock = true;
    try {
      await cookieRefreshWork();
    }
    finally {
      cookieRefreshLock = false;
    }
  });

  // Prepare data per 30s
  const prepare = new schedule.RecurrenceRule();
  prepare.second = [0, 30];
  schedule.scheduleJob(prepare, () => {
    prepareWork().then((res) => (data = res));
  });

  // Start update work per 30s
  const startUpdate = new schedule.RecurrenceRule();
  startUpdate.second = [29, 59];
  schedule.scheduleJob(startUpdate, () => {
    data && startUpdateWork(data);
  });

  // Start send friend request & accept friend per 30s
  const sendFriendRequest = new schedule.RecurrenceRule();
  sendFriendRequest.second = [29, 59];
  schedule.scheduleJob(sendFriendRequest, () => {
    data && [sendFriendRequestWork(data), acceptFriendWork(data)];
  });

  console.log("Configure bot done!")
}

export { configureBot };
