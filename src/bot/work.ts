import {
  QueueData,
  delValue,
  getQueue,
  getValue,
  removeFromQueue,
  setValue,
} from "../db.js";
import {
  allowFriendRequest,
  blockFriendRequest,
  cancelFriendRequest,
  favoriteOnFriend,
  getAccpetRequests,
  getFriendList,
  getFriendVS,
  getSentRequests,
  removeFriend,
  sendFriendRequest,
  validateFriendCodeCached,
} from "./net.js";
import {
  getCookieValue,
  loadCookie,
  refreshCookie,
  removeCookie,
  testCookieExpired,
} from "./cookie.js";
import { useStage, useTrace } from "../trace.js";

import config from "../config.js";
import fetch from "node-fetch";
import { sleep } from "../util.js";

var queueLock = false;

export type WorkerData = {
  friends: string[];
  requests: string[];
  accepts: string[];
};

async function updateWork({
  username,
  password,
  traceUUID,
  friendCode,
}: QueueData) {
  const trace = useTrace(traceUUID);
  const stage = useStage(trace);

  await stage(
    "更新数据",
    10,
    async () => {
      const descriptions = [
        "Basic",
        "Advanced",
        "Expert",
        "Master",
        "Re:Master",
      ];
      await favoriteOnFriend(friendCode);

      // Update data
      await Promise.all(
        [0, 1, 2, 3, 4].map(async (diff) =>
          stage(
            `更新 ${descriptions[diff]} 难度数据`,
            16,
            async () => {
              // Sleep random time to avoid ban
              await sleep(1000 * (diff + 1) * 2 + 1000 * 5 * Math.random());

              const result: [string | undefined, string | undefined] = [
                undefined,
                undefined,
              ];
              await stage(
                `获取 ${descriptions[diff]} 难度友人对战数据`,
                0,
                async () => {
                  await Promise.all(
                    [1, 2].map(async (i) => {
                      const body = await getFriendVS(
                        friendCode,
                        i as 1 | 2,
                        diff
                      );
                      const m = body.match(/<html.*>([\s\S]*)<\/html>/);
                      if (!m || !m[1]) {
                        throw new Error(
                          `获取 ${descriptions[diff]} 难度友人对战数据失败`
                        );
                      }
                      result[i - 1] = m[1].replace(/\s+/g, " ");
                    })
                  );
                }
              );

              await stage(
                `上传 ${descriptions[diff]} 难度数据`,
                0,
                async () => {
                  const url = `${config.pageParserHost}/page/friendVS`;
                  const uploadResult = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "text/plain" },
                    body: `<login><u>${username}</u><p>${password}</p></login><dxscorevs>${result[0]}</dxscorevs><achievementsvs>${result[1]}</achievementsvs>`,
                  });

                  await trace({
                    log: `diving-fish 上传 ${
                      descriptions[diff]
                    } 分数接口返回消息: ${await uploadResult.text()}`,
                  });
                }
              );
            },
            true
          )
        )
      );

      await trace({
        log: `maimai 数据更新完成`,
        status: "success",
      });

      removeFriend(friendCode).catch();
    },
    true
  );
}

async function sendFriendRequestWork(data: WorkerData) {
  console.log("[Bot][SendFriendRequestWork] Start");
  getQueue().forEach((item) => {
    const { friendCode, traceUUID } = item;
    const trace = useTrace(traceUUID);
    if (
      data.friends.includes(friendCode) ||
      data.accepts.includes(friendCode)
    )
      return;

    // If not found friend request, send one
    if (!data.requests.includes(friendCode)) {
      if (
        !item.requestSentTime ||
        Date.now() - item.requestSentTime > 1000 * 60 * 1
      ) {
        item.requestSentTime = Date.now();
        trace({ log: `正在尝试发送好友请求...` });
        validateFriendCodeCached(friendCode).then((result) => {
          result
            ? [sendFriendRequest(friendCode).catch()]
            : [
                trace({ log: "不存在的好友代码！", status: "failed" }),
                removeFromQueue(item),
              ];
        }).catch();
      }
      return;
    }

    // We got friend request below
    if (!item.requestConfirmedTime) {
      item.requestConfirmedTime = Date.now();
      trace({ log: `好友请求发送成功，请在5分钟内接受！` });
    } else if (Date.now() - item.requestConfirmedTime > 1000 * 60 * 5) {
      trace({ log: `5分钟内未接受好友请求，请重试！`, status: "failed" });
      removeFromQueue(item);
    }
  });
  console.log("[Bot][SendFriendRequestWork] Done");
}

async function startUpdateWork(data: WorkerData) {
  console.log("[Bot][StartUpdateWork] Start");
  getQueue().forEach(async (item) => {
    const { friendCode, traceUUID } = item;
    const trace = useTrace(traceUUID);
    if (data.friends?.includes(friendCode) && !(await getValue(friendCode))) {
      await setValue(friendCode, "place-hold");
      await trace({ log: "已确认好友存在!" });

      // Remove from pending queue
      removeFromQueue(item);

      // Start update
      updateWork(item)
        .catch(async (error) => {
          await trace({ log: `更新失败: ${String(error)}`, status: "failed" });

          removeFriend(friendCode);
          removeFromQueue(item);
          await delValue(friendCode);
          console.log("[Bot][StartUpdateWork] Error: ", error);
        })
        .then(async () => {
          removeFromQueue(item);
          await delValue(friendCode);
          console.log("[Bot][StartUpdateWork] Done");
        });
    }
  });
  console.log("[Bot][StartUpdateWork] Done");
}

async function acceptFriendWork(data: WorkerData) {
  console.log("[Bot][AcceptFriendWork] Start");
  getQueue().forEach(async (item) => {
    const { friendCode, traceUUID } = item;
    const trace = useTrace(traceUUID);
    if (
      data.friends.includes(friendCode) ||
      data.requests.includes(friendCode)
    )
      return;

    if (data.accepts.includes(friendCode)) {
      if (
        !item.acceptSentTime ||
        Date.now() - item.acceptSentTime > 1000 * 60 * 1
      ) {
        await trace({ log: `正在尝试接受好友请求...` });
        item.acceptSentTime = Date.now();
        allowFriendRequest(friendCode).catch();
        console.log("[Bot][AcceptFriendWork] Accept friend: ", friendCode);
      }
      return;
    }
  });
  console.log("[Bot][AcceptFriendWork] Done");
}

async function cleanUpAcceptWork(data: WorkerData) {
  console.log("[Bot][CleanUpAcceptWork] Start");
  data.accepts?.forEach(async (friendCode) => {
    if (
      data.friends.includes(friendCode) ||
      !getQueue().some((item) => item.friendCode === friendCode)
    ) {
      blockFriendRequest(friendCode).catch();
      console.log("[Bot][CleanUpAcceptWork] Block friend: ", friendCode);
    }
  });
  console.log("[Bot][CleanUpAcceptWork] Done");
}

async function cleanUpFriendWork(data: WorkerData) {
  console.log("[Bot][CleanUpFriendWork] Start");
  data.friends.forEach(async (friendCode) => {
    if (
      !getQueue().some((item) => item.friendCode === friendCode) &&
      !(await getValue(friendCode))
    ) {
      removeFriend(friendCode).catch();
      console.log("[Bot][CleanUpFriendWork] Remove friend: ", friendCode);
    }
  });
  console.log("[Bot][CleanUpFriendWork] Done");
}

async function cleanUpSentRequestWork(data: WorkerData) {
  console.log("[Bot][CleanUpSentRequestWork] Start");
  data.requests.forEach(async (friendCode) => {
    if (
      data.friends.includes(friendCode) ||
      !getQueue().some((item) => item.friendCode === friendCode)
    ) {
      cancelFriendRequest(friendCode).catch();
      console.log("[Bot][CleanUpSentRequestWork] Cancel reqiest: ", friendCode);
    }
  });
  console.log("[Bot][CleanUpSentRequestWork] Done");
}

async function cleanUpLongQueueTaskWork(data: WorkerData) {
  console.log("[Bot][CleanUpLongQueueTaskWork] Start");
  getQueue().forEach(async (item) => {
    if (Date.now() - item.createTime > 1000 * 60 * 5) {
      const { traceUUID } = item;
      const trace = useTrace(traceUUID);
      removeFromQueue(item);
      await delValue(item.friendCode);
      await trace({ log: `在队列中的等待时间过长，请重试!`, status: "failed" });
      console.log("[Bot][CleanUpLongQueueTaskWork] Remove item: ", item);
    }
  });
  console.log("[Bot][CleanUpLongQueueTaskWork] Done");
}

async function prepareWork() {
  const data: WorkerData = {
    friends: [],
    requests: [],
    accepts: [],
  };
  console.log("[Bot][PrepareWork] Start");
  try {
    await Promise.all([
      getFriendList().then((result) => (data.friends = result)),
      getAccpetRequests().then((result) => (data.accepts = result)),
      getSentRequests().then((result) => (data.requests = result)),
    ]);
    if (getQueue().length >= 10 || (data.friends?.length || 0) >= 20) {
      queueLock = true;
    } else {
      queueLock = false;
    }
  }
  catch(err) {
    console.log("[Bot][PrepareWork] Failed to load data, error: ", err);
    return undefined
  }
  console.log("[Bot][PrepareWork] Done, data: ", data);
  return data;
}

async function cookieRefreshWork() {
  console.log("[Bot][CookieRefresh] Start");
  let failed = true;

  for (let i = 0; i < 3; ++i) {
    const cj = await loadCookie();
    if (await testCookieExpired(cj) === false) {
      failed = false;
      break;
    } else {
      console.log(`[Bot][CookieRefresh] ${i} time test failed`);
      await new Promise((r) => {
        setTimeout(r, 1000 * 10);
      });
    }
  }

  if (failed) {
    console.log("[Bot][CookieRefresh] Cookie expired, refresh...");
    await removeCookie();
    await refreshCookie();
    console.log(
      "[Bot][CookieRefresh] Reload done, cookie: ",
      getCookieValue(await loadCookie())
    );
  } else {
    console.log("[Bot][CookieRefresh] Done");
  }
}

export {
  queueLock,
  cookieRefreshWork,
  prepareWork,
  startUpdateWork,
  sendFriendRequestWork,
  acceptFriendWork,
  cleanUpAcceptWork,
  cleanUpFriendWork,
  cleanUpSentRequestWork,
  cleanUpLongQueueTaskWork,
};
