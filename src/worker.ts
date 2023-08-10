import * as schedule from "node-schedule";

import { GameType, updateChunithmScore, updateMaimaiScore } from "./crawler.js";

import { Task } from "./web.js";
import config from "./config.js";
import fetch from "node-fetch";

const configureWorker = () => {
  console.log(`Worker enabled`);
  const getWork = new schedule.RecurrenceRule();
  getWork.second = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  schedule.scheduleJob(getWork, async () => {
    const url = `${config.worker.task}?token=${config.authToken}`;
    let res = await fetch(url);
    if (res.status !== 400) {
      const { data, uuid, type } = (await res.json()) as Task;
      console.log("[Worker] Get task", res.status, uuid, type)
      const url = `${config.worker.task}/${uuid}?token=${config.authToken}`;
      res = await fetch(url, { method: "post" });
      const { username, password, authUrl, diffList, traceUUID, pageInfo } = data;
      const func = type === GameType.maimai ? updateMaimaiScore : updateChunithmScore;
      func(username, password, authUrl, traceUUID, diffList, pageInfo);
    }
  });
};

export { configureWorker };
