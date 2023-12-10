import * as schedule from "node-schedule";

import { GameType, lock, queue, updateChunithmScore, updateMaimaiScore } from "./crawler.js";

import { Task } from "./web.js";
import config from "./config.js";
import fetch from "node-fetch";
import { useTrace } from "./trace.js";

var lastFire = 0;

const configureWorker = () => {
  console.log(`Worker enabled`);
  const getWork = new schedule.RecurrenceRule();
  // Every 2 second
  getWork.second = [...Array.from({ length: 60 }, (_, i) => i)].filter(i => i % 2 === 0);
  schedule.scheduleJob(getWork, async () => {
    if (lock) {
      console.log("[Worker] Lock fetch task")
      return;
    }
    // 0 - 10 - 20 - 30 - 40 - 50 - 60
    // 2s - 4s - 8s - 16s - 32s - 64s - 128s
    if (Date.now() - lastFire < Math.pow(2, queue.length / 10) * 1000 + 1) {
      return;
    }

    try {
      lastFire = Date.now();
      const url = `${config.worker.task}?token=${config.authToken}`;
      let res = await fetch(url);
      if (res.status !== 400) {
        const { data, uuid, type, appendTime } = (await res.json()) as Task;
        const { username, password, authUrl, diffList, traceUUID, pageInfo } = data;
        console.log("[Worker] Get task", res.status, uuid, type)
        const url = `${config.worker.task}${uuid}/?token=${config.authToken}`;
        res = await fetch(url, { method: "post" });
        if (res.status === 200) {
          console.log("[Worker] Start task", res.status, uuid)
          // 1 min timeout for task
          if (Date.now() - appendTime > 60 * 1000) {
            const trace = useTrace(traceUUID);
            console.log("[Worker] Task timeout", res.status, uuid)
            await trace({ log: `等待时间过长，请重试`, status: "failed"});
            return;
          }

          const func = type === GameType.maimai ? updateMaimaiScore : updateChunithmScore;
          func(username, password, authUrl, traceUUID, diffList, pageInfo).catch(console.log);
        }
        else {
          console.log("[Worker] Failed to ack task", res.status, uuid)
        }
      }
    }
    catch(err) {
      console.log("[Worker] Failed when get task", err)
    }
  });
};

export { configureWorker };
