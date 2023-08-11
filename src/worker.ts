import * as schedule from "node-schedule";

import { GameType, lock, updateChunithmScore, updateMaimaiScore } from "./crawler.js";

import { Task } from "./web.js";
import config from "./config.js";
import fetch from "node-fetch";

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
    try {
      const url = `${config.worker.task}?token=${config.authToken}`;
      let res = await fetch(url);
      if (res.status !== 400) {
        const { data, uuid, type } = (await res.json()) as Task;
        console.log("[Worker] Get task", res.status, uuid, type)
        const url = `${config.worker.task}${uuid}/?token=${config.authToken}`;
        res = await fetch(url, { method: "post" });
        if (res.status === 200) {
          console.log("[Worker] Start task", res.status, uuid)
          const { username, password, authUrl, diffList, traceUUID, pageInfo } = data;
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
