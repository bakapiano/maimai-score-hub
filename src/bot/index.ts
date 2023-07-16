import * as schedule from "node-schedule";
import * as workerpool from "workerpool";

import {
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

import { WorkerPoolOptions } from "workerpool";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);


function configureBot() {
  // Clean up per 3 mins
  const cleanUpPool = workerpool.pool(path.join(__dirname, "work.js"), {
    maxQueueSize: 1,
    workerType: "process",
  } as WorkerPoolOptions);
  const cleanUp = new schedule.RecurrenceRule();
  cleanUp.minute = [
    0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57,
  ];
  schedule.scheduleJob(cleanUp, () => {
    cleanUpPool
      .exec(
        "updateWork", []
        // () =>
        //   Promise.all([
        //     cleanUpAcceptWork,
        //     cleanUpFriendWork,
        //     cleanUpSentRequestWork,
        //     cleanUpLongQueueTaskWork,
        //   ]),
        // []
      )
      .timeout(1000 * 3)
      .catch((err) => {
        console.log("[Bot][CleanUp] Clean up error:", err);
      });
  });

  // // Cookie refresh per 15 seconds
  // const cookieRefreshPool = workerpool.pool({
  //   maxQueueSize: 1,
  //   workerType: "process",
  // } as WorkerPoolOptions);
  // const cookieRefresh = new schedule.RecurrenceRule();
  // cookieRefresh.second = [0, 15, 30, 45];
  // schedule.scheduleJob(cookieRefresh, () => {
  //   cookieRefreshPool
  //     .exec(cookieRefreshWork, [])
  //     .timeout(1000 * 3)
  //     .catch((err) => {
  //       console.log("[Bot][CookieRefresh] Cookie refresh error:", err);
  //     });
  // });

  // // Prepare per 1 min
  // const preparePool = workerpool.pool({
  //   maxQueueSize: 1,
  //   workerType: "process",
  // } as WorkerPoolOptions);
  // const prepare = new schedule.RecurrenceRule();
  // prepare.second = [0];
  // schedule.scheduleJob(prepare, () => {
  //   preparePool
  //     .exec(() => Promise.all([prepareWork]), [])
  //     .timeout(1000 * 2)
  //     .catch((err) => {
  //       console.log("[Bot][Prepare] Prepare error:", err);
  //     });
  // });

  // // Start update work per 1 min
  // const startUpdatePool = workerpool.pool({
  //   maxQueueSize: 1,
  //   workerType: "process",
  // } as WorkerPoolOptions);
  // const startUpdate = new schedule.RecurrenceRule();
  // startUpdate.second = [0];
  // schedule.scheduleJob(startUpdate, () => {
  //   startUpdatePool
  //     .exec(() => Promise.all([startUpdateWork]), [])
  //     .timeout(1000 * 2)
  //     .catch((err) => {
  //       console.log("[Bot][StartUpdate] Start update error:", err);
  //     });
  // });

  // // Start send friend request & accept friend per 1 min
  // const sendFriendRequestPool = workerpool.pool({
  //   maxQueueSize: 1,
  //   workerType: "process",
  // } as WorkerPoolOptions);
  // const sendFriendRequest = new schedule.RecurrenceRule();
  // sendFriendRequest.second = [0];
  // schedule.scheduleJob(sendFriendRequest, () => {
  //   sendFriendRequestPool
  //     .exec(() => Promise.all([sendFriendRequestWork, acceptFriendWork]), [])
  //     .timeout(1000 * 2)
  //     .catch((err) => {
  //       console.log("[Bot][SendFriendRequest] Send friend request error:", err);
  //     });
  // });
}

export { configureBot };
