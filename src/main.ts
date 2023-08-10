import { RecurrenceRule, scheduleJob } from "node-schedule";
import {
  clearExpireData,
  saveFileDB,
} from "./db.js";

import config from "./config.js";
import { configureBot } from "./bot/index.js";
import { configureWorker } from "./worker.js";
import { interProxy } from "./inter-proxy.js";
import { proxy } from "./proxy.js";
import { server } from "./web.js";

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
  server.on("error", (error : any) => console.log(`Server error ${error}`));
  console.log(`HTTP server listen on ${config.httpServer.port}`);
}

if (config.httpProxy.enable) {
  proxy.listen(config.httpProxy.port);
  proxy.on("error", (error : any) => console.log(`Proxy error ${error}`));
  console.log(`Proxy server listen on ${config.httpProxy.port}`);
}

if (config.bot.enable) {
  configureBot()
}

if (config.worker.enable) {
  configureWorker()
}

// Create a schedule to clear in-memory DB and save count
const rule = new RecurrenceRule();
rule.minute = [];
for (let min = 0; min < 60; min += 5) {
  rule.minute.push(min);
}
scheduleJob(rule, async () => {
  try {
    console.log(`Clear in-memory DB and save count...`);
    await saveFileDB();
    await clearExpireData();
  } catch (err) {
    console.error(err);
  }
});