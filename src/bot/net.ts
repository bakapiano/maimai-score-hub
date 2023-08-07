import { addFriendCodeCache, checkFriendCodeCache } from "../db.js";
import { fetchWithCookieWithRetry, sleep } from "../util.js";
import { loadCookie, testCookieExpired, updateCookie } from "./cookie.js";
import { lock, release } from "./lock.js";

var queue: any[] = [];
const fetch = async (
  url: string,
  options: any | undefined = undefined,
  retry: number = 1,
  fetchTimeout: number = 1000 * 30
) : Promise<any> => {
  return await new Promise((resolve, reject) => {
    queue.push({
      url,
      options,
      retry,
      fetchTimeout,
      resolve,
      reject,
    });
  });
};

setInterval(() => {
  if (queue.length === 0) return;
  console.log("[Bot][Fetch] Queue length:", queue.length);
  if (queue.length >= 60) lock("fetch-queue")
  else release("fetch-queue")
  const { url, options, retry, fetchTimeout, resolve, reject } = queue.shift();
  doFetch(url, options, retry, fetchTimeout).then(resolve).catch(reject);
}, 1500);

const doFetch = async (
  url: string,
  options: any | undefined = undefined,
  retry: number = 1,
  fetchTimeout: number = 1000 * 30
) : Promise<any> => { 
  const cj = await loadCookie();

  // Auto add token to POST body
  let fetchOptions = { ...options };
  if (fetchOptions.addToken) {
    const token = cj?.cookies?.get("maimai.wahlap.com")?.get("_t")?.value;
    delete fetchOptions.addToken;
    fetchOptions = {
      ...options,
      body: `${options.body}&token=${token}`,
    };
  }

  const result = await fetchWithCookieWithRetry(
    cj,
    url,
    fetchOptions,
    fetchTimeout
  );
  if (result.url.indexOf("error") !== -1) {
    const cookieExpired = await testCookieExpired(cj);

    // For not cookie expired error, retry 2 times
    if (!cookieExpired && retry === 3) {
      throw new Error("[Bot][Fetch] Retry hit max limit.");
    }

    // For cookie expired error, retry 10 times
    if (retry === 10) {
      throw new Error(
        "[Bot][Fetch] Retry hit max limit, failed to refresh cookie."
      );
    }

    const text = await result.text();
    const errroCode = text.match(/<div class="p_5 f_14 ">(.*)<\/div>/)[1];
    const errorBody = text.match(
      /<div class="p_5 f_12 gray break">(.*)<\/div>/
    )[1];

    console.log(
      `[Bot][Fetch] Fetch error, try to reload cookie and retry. Retry time: ${retry}`
    );
    console.log("[Bot][Fetch] Request url:", url);
    console.log("[Bot][Fetch] Error url:", result.url);
    console.log("[Bot][Fetch] ErrorError code:", errroCode);
    console.log("[Bot][Fetch] ErrorError body:", errorBody);

    return await new Promise((resolve, reject) => {
      sleep(1000 * 15).then(() =>
        fetch(url, options, retry + 1, fetchTimeout)
          .then(resolve)
          .catch(reject)
      );
    });
  }

  // Update cookie value if changed
  updateCookie(cj).catch(console.log);

  return result;
};

const cancelFriendRequest = async (friendCode: string) => {
  console.log(
    `[Bot][Net] Start cancel friend request, friend code ${friendCode}`
  );
  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/invite/cancel/", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}&invite=`,
    method: "POST",
    addToken: true,
  });
  console.log(
    `[Bot][Net] Done cancel friend request, friend code ${friendCode}`
  );
};

const getSentRequests = async () => {
  console.log(`[Bot][Net] Start get sent friend requests`);
  const result = await fetch(
    "https://maimai.wahlap.com/maimai-mobile/friend/invite/"
  );
  const text = await result.text();
  const t = text.matchAll(/<input type="hidden" name="idx" value="(.*?)"/g);
  const ids = [...new Set([...t].map((x) => x[1]))];
  console.log(`[Bot][Net] Done get sent friend requests: `, ids);
  return ids;
};

const getAccpetRequests = async () => {
  console.log(`[Bot][Net] Start get accept friend requests`);
  const result = await fetch(
    "https://maimai.wahlap.com/maimai-mobile/friend/accept/"
  );
  const text = await result.text();
  const t = text.matchAll(/<input type="hidden" name="idx" value="(.*?)"/g);
  const ids = [...new Set([...t].map((x) => x[1]))];
  console.log(`[Bot][Net] Done get accept friend requests: `, ids);
  return ids;
};

const allowFriendRequest = async (friendCode: string) => {
  console.log(
    `[Bot][Net] Start allow friend request, friend code ${friendCode}`
  );
  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/accept/allow/", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}&allow=`,
    method: "POST",
    addToken: true,
  });

  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/accept/allow/");
  console.log(
    `[Bot][Net] Done allow friend request, friend code ${friendCode}`
  );
};

const blockFriendRequest = async (friendCode: string) => {
  console.log(
    `[Bot][Net] Start block friend request, friend code ${friendCode}`
  );
  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/accept/block/", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}&block=`,
    method: "POST",
    addToken: true,
  });

  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/accept/block/");
  console.log(
    `[Bot][Net] Done block friend request, friend code ${friendCode}`
  );
};

const favoriteOnFriend = async (friendCode: string) => {
  console.log(`[Bot][Net] Start favorite on friend, friend code ${friendCode}`);
  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/favoriteOn/", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}`,
    method: "POST",
    addToken: true,
  });
  console.log(`[Bot][Net] Done favorite on friend, friend code ${friendCode}`);
};

const favoriteOffFriend = async (friendCode: string) => {
  console.log(
    `[Bot][Net] Start favorite off friend, friend code ${friendCode}`
  );
  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/favoriteOff/", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}`,
    method: "POST",
    addToken: true,
  });
  console.log(`[Bot][Net] Done favorite off friend, friend code ${friendCode}`);
};

const getFriendVS = async (
  friendCode: string,
  scoreType: 1 | 2,
  diff: number
): Promise<string> => {
  let url = `https://maimai.wahlap.com/maimai-mobile/friend/friendGenreVs/battleStart/?scoreType=${scoreType}&genre=99&diff=${diff}&idx=${friendCode}`;
  const result = await fetch(url, {}, 1, 1000 * 60 * 5);
  return await result.text();
};

const getFriendList = async () => {
  console.log(`[Bot][Net] Start get friend list`);
  const url = "https://maimai.wahlap.com/maimai-mobile/index.php/friend/";
  const result = await fetch(url);
  const text = await result.text();
  const t = text.matchAll(/<input type="hidden" name="idx" value="(.*?)"/g);
  const ids = [...new Set([...t].map((x) => x[1]))];
  console.log(`[Bot][Net] Done get friend list`);
  return ids;
};

const removeFriend = async (friendCode: string) => {
  console.log(`[Bot][Net] Start remove friend, friend code ${friendCode}`);
  const url =
    "https://maimai.wahlap.com/maimai-mobile/friend/friendDetail/drop/";
  await fetch(url, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}`,
    method: "POST",
    addToken: true,
  });
  console.log(`[Bot][Net] Done remove friend, friend code ${friendCode}`);
};

const sendFriendRequest = async (friendCode: string) => {
  console.log(
    `[Bot][Net] Start send friend request, friend code ${friendCode}`
  );
  await fetch("https://maimai.wahlap.com/maimai-mobile/friend/search/invite/", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `idx=${friendCode}&invite=`,
    method: "POST",
    addToken: true,
  });

  await fetch(
    "https://maimai.wahlap.com/maimai-mobile/index.php/friend/invite/"
  );

  console.log(`[Bot][Net] Done send friend request, friend code ${friendCode}`);
};

const validateFriendCode = async (friendCode: string) => {
  console.log(
    `[Bot][Net] Start validate friend code, friend code ${friendCode}`
  );

  const result = await fetch(
    `https://maimai.wahlap.com/maimai-mobile/friend/search/searchUser/?friendCode=${friendCode}`
  );
  const body = await result.text();
  const validateResult = body.indexOf("找不到该玩家") === -1;

  console.log(
    `[Bot][Net] Done validate friend code, friend code ${friendCode}, result ${validateResult}`
  );
  return validateResult;
};

async function validateFriendCodeCached(friendCode: string) {
  if (checkFriendCodeCache(friendCode)) return true;
  const result = await validateFriendCode(friendCode);
  if (result) addFriendCodeCache(friendCode);
  return result;
}

export {
  getFriendList,
  removeFriend,
  sendFriendRequest,
  cancelFriendRequest,
  getSentRequests,
  favoriteOffFriend,
  favoriteOnFriend,
  getFriendVS,
  validateFriendCode,
  getAccpetRequests,
  allowFriendRequest,
  blockFriendRequest,
  validateFriendCodeCached,
};
