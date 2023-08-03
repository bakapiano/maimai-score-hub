import * as fs from "fs";

import { CookieJar } from "node-fetch-cookies";
import config from "../config.js";
import fetch from "node-fetch";
import { fetchWithCookieWithRetry } from "../util.js";
import lodash from "lodash";
import { sleep } from "../util.js";

const { throttle } = lodash

async function removeCookie() {
  try {
    fs.unlinkSync(config.bot.cookiePath);
  } catch (_err) {}
  return;
}

async function refreshCookie() {
  // Trigger a wechat login
  const url = `${config.bot.trigger}/trigger?token=${config.authToken}`;
  console.log("[Bot] Start refresh cookie: ", url);
  await fetch(url);

  for (let i = 0; i < 60 * 2; ++i) {
    // Check cookie file exists
    if (fs.existsSync(config.bot.cookiePath)) return;
    await sleep(1000);
  }

  throw new Error("Failed to refresh cookie");
}

async function loadCookie() {
  try {
    const cj = new CookieJar(config.bot.cookiePath);
    await cj.load();
    return cj;
  } catch (err) {
    return new CookieJar();
  }
}

async function updateCookie(cj: any) {
  const old = await loadCookie();
  const [cjValue, oldValue] = [getCookieValue(cj), getCookieValue(old)];
  if (
    Object.keys(cjValue)
      .filter((key) => ["_t", "userId", "friendCodeList"].includes(key))
      .some(
        (key) =>
          cjValue[key as "_t" | "userId" | "friendCodeList"] !==
          oldValue[key as "_t" | "userId" | "friendCodeList"]
      ) &&
    !(await testCookieExpired(cj))
  ) {
    {
      console.log("[Fetch] Cookies changes", cjValue, oldValue);
      Object.keys(cjValue).forEach(
        (key) =>
          (cj.cookies.get("maimai.wahlap.com").get(key).expiry =
            new Date().setFullYear(2099))
      );
      await cj.save(config.bot.cookiePath);
    }
  }
}

async function saveCookie(cj: any) {
  const value = await getCookieValue(cj);
  Object.keys(value).forEach((key) => {
    // Set cookie expire day to 2099, or will lose this value when save cookie to file
    // This may be a bug(or by design) for CookieJar from node-fetch-cookies
    const value = cj?.cookies?.get("maimai.wahlap.com")?.get(key);
    value.expiry = new Date().setFullYear(2099);
  });
  await cj.save(config.bot.cookiePath);
}

function getCookieValue(cj: any) {
  return {
    _t: cj.cookies?.get("maimai.wahlap.com")?.get("_t")?.value,
    userId: cj.cookies?.get("maimai.wahlap.com")?.get("userId")?.value,
    friendCodeList: cj.cookies?.get("maimai.wahlap.com")?.get("friendCodeList")
      ?.value,
  };
}

const testCookieExpired = throttle(async (cj: any): Promise<boolean> => {
  console.log("[Bot] Start test cookie expired: ", getCookieValue(cj));
  try {
    const result = await fetchWithCookieWithRetry(
      cj,
      "https://maimai.wahlap.com/maimai-mobile/home/"
    );
    const body = await result.text();
    const testReuslt = body.indexOf("登录失败") !== -1;
    console.log("[Bot] Done test cookie expired: ", testReuslt);
    return testReuslt;
  } catch (err) {
    console.log("[Bot] Done test cookie expired with error: ", err);
    return true;
  }
})

export {
  refreshCookie,
  loadCookie,
  removeCookie,
  updateCookie,
  saveCookie,
  getCookieValue,
  testCookieExpired,
};
