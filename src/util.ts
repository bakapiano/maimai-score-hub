import * as http from "node:http";
import * as https from "node:https";

import config from "./config.js";
import { fetch } from "node-fetch-cookies";

async function fetchWithCookieWithRetry(cj: any, url: string, options : any | undefined = undefined, fetchTimeout: number | undefined = undefined) {
  for (let i = 0; i < config.fetchRetryCount; i++) {
    try {
      const result = await fetch(cj, url, {
        signal: (AbortSignal as any).timeout(fetchTimeout || config.fetchTimeOut),
        agent: function (_parsedURL: any) {
          if (_parsedURL.protocol == "http:") {
            return new http.Agent({ keepAlive: true });
          } else {
            return new https.Agent({ keepAlive: true });
          }
        },
        ...options,
      });
      return result;
    } catch (e) {
      console.log(`Delay due to fetch failed with attempt ${url} #${i + 1}, error: ${e}`);
      if (i === config.fetchRetryCount - 1) throw e;

      await new Promise((r) => {
        setTimeout(r, 1000);
      });
    }
  }
} 

async function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { fetchWithCookieWithRetry, sleep };
