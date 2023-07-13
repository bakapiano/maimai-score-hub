import {
  addFriendCodeCache,
  appendQueue,
  checkFriendCodeCache,
  clearExpireData,
  delValue,
  getQueue,
  getValue,
  popQueue,
  saveFileDB,
  setValue,
} from "./src/db.js";
import {
  allowFriendRequest,
  blockFriendRequest,
  cancelFriendRequest,
  favoriteOffFriend,
  favoriteOnFriend,
  getAccpetRequests,
  getFriendList,
  getFriendVS,
  getSentRequests,
  removeFriend,
  sendFriendRequest,
  testCookieExpired,
  validateFriendCode,
} from "./src/bot.js";
import { loadCookie, refreshCookie } from "./src/wechat.js";
import { useStage, useTrace } from "./src/trace.js";

import { CookieJar } from "node-fetch-cookies";
import config from "./config.js";
import fetch from "node-fetch";
import fs from "fs";
import { v4 as genUUID } from "uuid";
import { interProxy } from "./src/inter-proxy.js";
import { proxy } from "./src/proxy.js";
import schedule from "node-schedule";
import { server } from "./src/server.js";

// Print time for console.log
console.log = (function () {
  const orig = console.log;
  return function () {
    const args = Array.from(arguments);
    args.unshift(`[${new Date().toLocaleString()}]`);
    orig.apply(null, args);
  };
})();

if (config.interProxy.enable) {
  interProxy.listen(config.interProxy.port);
  interProxy.on("error", (error) => console.log(`Inter proxy error ${error}`));
  console.log(`Inter proxy server listen on ${config.interProxy.port}`);
}

if (config.httpServer.enable) {
  server.listen(config.httpServer.port);
  server.on("error", (error) => console.log(`Server error ${error}`));
  console.log(`HTTP server listen on ${config.httpServer.port}`);
}

if (config.httpProxy.enable) {
  proxy.listen(config.httpProxy.port);
  proxy.on("error", (error) => console.log(`Proxy error ${error}`));
  console.log(`Proxy server listen on ${config.httpProxy.port}`);
}

// Create a schedule to clear in-memory DB and save count
const rule = new schedule.RecurrenceRule();
rule.minute = [];
for (let min = 0; min < 60; min += 5) {
  rule.minute.push(min);
}
schedule.scheduleJob(rule, async () => {
  try {
    console.log(`Clear in-memory DB and save count...`);
    await saveFileDB();
    await clearExpireData();
  } catch (err) {
    console.error(err);
  }
});

// Set up bot
const botRule = new schedule.RecurrenceRule();
botRule.second = [0, 10, 20, 30, 40, 50];
var lock = undefined;
function single(func) {
  return async () => {
    if (lock !== undefined) return;
    lock = genUUID();
    const lockTimeout = setInterval(async () => {
      cj = await loadCookie();
      if (!await testCookieExpired(cj)) {
        lock = undefined;
        console.log("[Bot] Cacncel lock");
        clearInterval(lockTimeout);
      }
    }, 1000 * 60 * 1.5);
    try {
      await func(lock);
    } catch (err) {
      console.log(err);
    } finally {
      lock = undefined;
      clearInterval(lockTimeout);
    }
  };
}

var timeoutBlock = {}
const botCookieRefresher = new schedule.RecurrenceRule();
botCookieRefresher.second = [0, 10, 20, 30, 40, 50];
var cookieLock = false;
function cookieSingle(func) {
  return async () => {
    if (cookieLock) return;
    cookieLock = true;
    try {
      await func();
    } catch (err) {
      console.log(err);
    } finally {
      cookieLock = false;
    }
  };
}
if (config.bot.enable)
  schedule.scheduleJob(
    botCookieRefresher,
    cookieSingle(async () => {
      console.log("[CookieRefresher] Cookie refresher wake up");
      let cj = null;
      let failed = true;

      for (let i = 0; i < 3; ++i) {
        cj = await loadCookie();
        if (!(await testCookieExpired(cj))) {
          failed = false;
          break;
        } else {
          console.log(`[CookieRefresher] ${i} time test failed`);
          await new Promise((r) => {
            setTimeout(r, 1000 * 10);
          });
        }
      }

      if (failed) {
        console.log("[CookieRefresher] Cookie expired, refresh...");
        await refreshCookie();
        cj = await loadCookie();
      } else {
        console.log("[CookieRefresher] Cookie good");
      }
    })
  );

if (config.bot.enable)
  schedule.scheduleJob(
    botRule,
    single(async (_lock) => {
      console.log("[Bot] Bot wake up");

      let cj = null;
      cj = await loadCookie();

      const requests = await getSentRequests(cj);
      const friends = await getFriendList(cj);
      const acceptRequests = await getAccpetRequests(cj)
      const queue = getQueue();
      
      let count = Math.max(
        0,
        Math.min(10 - friends.length, 10 - requests.length)
      );    
      
      console.log("[Bot] Pending requests: ", requests);
      console.log("[Bot] Friends: ", friends);
      console.log("[Bot] Accept requests: ", acceptRequests);
      console.log("[Bot] Queue: ", getQueue());

      if (lock !== _lock) return

      // Clear pending requests
      for (const friendCode of requests) {
        const data = await getValue(friendCode);
        if (!data) {
          console.log(
            "[Bot] Cancel friend request by not found data: ",
            friendCode
          );
          cancelFriendRequest(cj, friendCode).catch();
        } else {
          const { time, traceUUID, status } = data;
          const trace = useTrace(traceUUID);
          const delta = new Date().getTime() - time;
          if ((status === "sent" && delta > 1000 * 60 * 5) || delta > 1000 * 60 * 10) {
            await trace({
              log: `长时间未接受好友请求，请重试`,
              status: "failed",
            });
            console.log("[Bot] Cancel friend request by timeout: ", friendCode);
            cancelFriendRequest(cj, friendCode)
              .catch()
              .finally(() => delValue(friendCode));
          }
        }
      }

      // 接受好友请求
      const accept = async (data) => {
        const { friendCode } = data
        await trace({
          log:"正在接受好友申请"
        })
        await setValue(friendCode, {
          ...data,
          status: "accepting",
          time: new Date().getTime(),
        });
        const timeout = setTimeout(async () => {
          const { status } = await getValue(friendCode)
          if (status === "accepting") {
            console.log("[Bot] Accept friend request timeout, append back:", data);
            await trace({
              log: `接受好友请求失败，请尝试重新添加或等待bot主动发起好友申请`,
            });
            appendQueue(data);
            await delValue(friendCode);
          }
        }, 1000 * 60 * 1);
        allowFriendRequest(cj, friendCode).then(async ()=>{
          clearTimeout(timeout);
          await trace({
            log: "成功接受好友申请",
            progress: 10,
          });
          await setValue(friendCode, {
            ...data,
            status: "sent",
            time: new Date().getTime(),
          });
        }).catch(async ()=>{
          await trace({
            log: `接受好友请求失败，请尝试重新添加或等待bot主动发起好友申请`,
          });
          clearTimeout(timeout);
          appendQueue(data);
          await delValue(friendCode);
        })
      }

      // Clear accept requests
      for (const friendCode of acceptRequests) {
        const data = await getValue(friendCode);
        const queue = getQueue();
        if (!data && !queue.find((value) => value.friendCode === friendCode)) {
          console.log(
            "[Bot] Cancel accept friend request by not found data: ",
            friendCode
          );
          if (!timeoutBlock[friendCode]) {
            timeoutBlock[friendCode] = setTimeout(async () => {
              const data = await getValue(friendCode);
              const queue = getQueue();
              if (!data && !queue.find((value) => value.friendCode === friendCode)) {
                blockFriendRequest(cj, friendCode).catch();
              }
              delete timeoutBlock[friendCode]
            }, 1000 * 60 * 5)
          }
        }
        else if (!data || (data.status !== "running" && data.status !== "accepting")){
          count -= 1
          await accept(data)
        }
      }

      // Pop up queue to send friendRequest

      while (true) {
        const data = popQueue();
        if (!data) break;

        console.log("[Bot] Processing queue front data:", data);

        const { friendCode, traceUUID, time } = data;
        const trace = useTrace(traceUUID);

        if (new Date().getTime() - time > 1000 * 60 * 10) {
          await trace({
            log: `在队列中的等待时间过长，请重试`,
            status: "failed",
          });
          await delValue(friendCode);
          continue;
        }
        
        if (requests.length >= 10 || friends.length >= 10 || count === 0) {
          await trace({ log: `bot好友数量已达上限，请稍后...` });
          appendQueue(data);
          continue;
        }

        // 好友已经存在 or 请求已发送
        if (
          friends.indexOf(friendCode) !== -1 ||
          requests.indexOf(friendCode) !== -1
        ) {
          let log = ""
          if (friends.indexOf(friendCode) !== -1) log = "好友已存在"
          if (requests.indexOf(friendCode) !== -1) log = "好友请求已发送"
          await trace({
            log,
            progress: 10,
          });
          await setValue(friendCode, {
            ...data,
            status: "sent",
            time: new Date().getTime(),
          });
          continue;
        }

        // 发送好友请求
        await trace({log: `正在发送好友请求...`})
        await setValue(friendCode, {
          ...data,
          status: "sending",
          time: new Date().getTime(),
        });
        const timeout = setTimeout(async () => {
          const { status } = await getValue(friendCode)
          if (status === "sending") {
            console.log("[Bot] Send friend request timeout, append back:", data);
            await trace({
              log: `好友请求发送失败，正在尝试重新发送好友请求...`,
            });
            appendQueue(data);
            await delValue(friendCode);
          }
        }, 1000 * 60 * 1);
        count -= 1;
        const next = async (result) => {
          if (!result) {
            await trace({
              log: `玩家不存在，请检查好友代码！`,
              status: "failed",
            });
            await delValue(friendCode);
            clearTimeout(timeout);
            return;
          }

          if (!checkFriendCodeCache(friendCode)) addFriendCodeCache(friendCode);

          sendFriendRequest(cj, friendCode)
            .then(async () => {
              await setValue(friendCode, {
                ...data,
                status: "sent",
                time: new Date().getTime(),
              });
              await trace({
                log: `好友请求发送成功！请在5分钟内同意好友请求来继续`,
                progress: 10,
              });
              clearTimeout(timeout);
            })
            .catch(async (err) => {
              await trace({
                log: `好友请求发送失败，正在尝试重新发送好友请求...`,
              });
              clearTimeout(timeout);
              appendQueue(data);
              await delValue(friendCode);
            });
        };
        if (checkFriendCodeCache(friendCode)) next(true);
        else {
          validateFriendCode(cj, friendCode)
            .then(next)
            .catch(async (err) => {
              clearTimeout(timeout);
              appendQueue(data);
              await delValue(friendCode);
            });
        }
      }

      // Process friend list
      for (const friendCode of friends) {
        const work = () =>
          new Promise(async (resolve) => {
            const data = await getValue(friendCode);

            console.log(friendCode, data);
            
            if (!data) {
              // 清理已经完成的好友
              console.log("[Bot] Remove friend:", friendCode);
              removeFriend(cj, friendCode).catch();
              return resolve();
            }

            const { username, password, traceUUID, status } = data;
            const trace = useTrace(traceUUID);
            const stage = useStage(trace);

            if (status === "running") {
              const { time } = data;
              const delta = new Date().getTime() - time;
              if (delta > 1000 * 60 * 20) {
                await trace({
                  log: `更新时间过长，请重试`,
                  status: "failed",
                });
                await delValue(friendCode);
                removeFriend(cj, friendCode).catch();
              }
              return resolve();
            }

            await trace({
              log: `已确认好友 ${friendCode} 存在...`,
            });
            await setValue(friendCode, {
              ...data,
              status: "running",
              time: new Date().getTime(),
            });
            resolve();

            try {
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
                  await favoriteOnFriend(cj, friendCode);

                  // Update data
                  await Promise.all(
                    [0, 1, 2, 3, 4].map(async (diff) =>
                      stage(
                        `更新 ${descriptions[diff]} 难度数据`,
                        16,
                        async () => {
                          // Sleep random time to avoid ban
                          await new Promise((r) =>
                            setTimeout(
                              r,
                              1000 * (diff + 1) * 2 + 1000 * 5 * Math.random()
                            )
                          );

                          let v1 = undefined;
                          let v2 = undefined;
                          await stage(
                            `获取 ${descriptions[diff]} 难度友人对战数据`,
                            0,
                            async () => {
                              await Promise.all([
                                getFriendVS(cj, friendCode, 1, diff).then(
                                  (result) => (v1 = result)
                                ),
                                getFriendVS(cj, friendCode, 2, diff).then(
                                  (result) => (v2 = result)
                                ),
                              ]);
                            }
                          );
                          v1 = v1
                            .match(/<html.*>([\s\S]*)<\/html>/)[1]
                            .replace(/\s+/g, " ");
                          v2 = v2
                            .match(/<html.*>([\s\S]*)<\/html>/)[1]
                            .replace(/\s+/g, " ");
                          await stage(
                            `上传 ${descriptions[diff]} 难度数据`,
                            0,
                            async () => {
                              const url = `${config.pageParserHost}/page/friendVS`;
                              const uploadResult = await fetch(url, {
                                method: "POST",
                                headers: { "content-type": "text/plain" },
                                body: `<login><u>${username}</u><p>${password}</p></login><dxscorevs>${v1}</dxscorevs><achievementsvs>${v2}</achievementsvs>`,
                              });

                              const log = `diving-fish 上传 ${
                                descriptions[diff]
                              } 分数接口返回消息: ${await uploadResult.text()}`;
                              await trace({ log });
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
                  // await favoriteOffFriend(cj, friendCode);
                  removeFriend(cj, friendCode).catch();
                },
                true
              );
            } catch (err) {
              console.log(err);
              await trace({
                log: `更新数据时出现错误: ${String(err)}`,
                status: "failed",
              });
            } finally {
              await delValue(friendCode);
            }
          });

        await work();
      }

      console.log("[Bot] Bot work done");
    })
  );
