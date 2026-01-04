import "./env.ts";

import config from "./config.ts";
import { proxy } from "./proxy.ts";
import { startServer } from "./api.ts";
import { startWorker } from "./worker.ts";

startServer();
startWorker();

proxy.listen(config.httpProxy.port);
proxy.on("error", (error: any) => console.log(`Proxy error ${error}`));
console.log(`V2 Proxy server listen on ${config.httpProxy.port}`);

console.log(fetch);
