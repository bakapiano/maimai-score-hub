import { fetchWithCookieWithRetry as doFetch, sleep } from "./util.js";
import { useStage, useTrace } from "./trace.js";

import { CookieJar } from "node-fetch-cookies";
import config from "./config.js";
import fetch from "node-fetch";

var lock = false

var queue: any[] = [];
const fetchWithCookieWithRetry = async (
  cj: CookieJar,
  url: string,
  options: any | undefined = undefined,
  fetchTimeout: number = 1000 * 30
) : Promise<any> => {
  return await new Promise((resolve, reject) => {
    queue.push({
      cj,
      url,
      options,
      fetchTimeout,
      resolve,
      reject,
    });
  });
};

setInterval(() => {
  if (queue.length === 0) return;
  console.log("[Crawler][Fetch] Queue length:", queue.length);
  if (queue.length >= 30) lock = true
  else lock = false
  const { cj, url, options, fetchTimeout, resolve, reject } = queue.shift();
  doFetch(cj, url, options, fetchTimeout).then(resolve).catch(e => {
    reject?.(e)
  });
}, 2000);

async function verifyProberAccount(username: string, password: string) {
  const res = await fetch(
    "https://www.diving-fish.com/api/maimaidxprober/login",
    {
      method: "post",
      headers: {
        Host: "www.diving-fish.com",
        Origin: "https://www.diving-fish.com",
        Referer: "https://www.diving-fish.com/maimaidx/prober/",
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify({ username, password }),
    }
  );
  const data: any = await res.json();
  return data.errcode == undefined;
}

export enum GameType {
  maimai = "maimai-dx",
  chunithm = "chunithm",
}

async function getAuthUrl(type: GameType) {
  if (!["maimai-dx", "chunithm"].includes(type)) {
    throw new Error("unsupported type");
  }

  const res = await fetch(
    `https://tgk-wcaime.wahlap.com/wc_auth/oauth/authorize/${type}`
  );
  const href = res.url.replace("redirect_uri=https", "redirect_uri=http");
  return href;
}

const getCookieByAuthUrl = async (authUrl: string) => {
  const cj = new CookieJar();
  const fetch = async (url: string, options: any | undefined = undefined) =>
    await fetchWithCookieWithRetry(cj, url, options);
  await fetch(authUrl, {
    headers: {
      Host: "tgk-wcaime.wahlap.com",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x6307001e)",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  await fetch("https://maimai.wahlap.com/maimai-mobile/home/");

  return cj;
};

export interface PageInfo {
  pageType: "A" | "G" | "W"
}

export enum MaimaiDiffType {
  Basic = "Basic",
  Advanced = "Advanced",
  Expert = "Expert",
  Master = "Master",
  ReMaster = "Re:Master",
}

const updateMaimaiScore = async (
  username: string,
  password: string,
  authUrl: string,
  traceUUID: string,
  diffList: MaimaiDiffType[],
  pageInfo: Map<MaimaiDiffType, PageInfo>,
) => {
  try {
    const trace = useTrace(traceUUID);
    const stage = useStage(trace);
    const cj = new CookieJar();
    const fetch = async (url: string, options: any = undefined, fetchTimeout : number = 1000 * 3 * 60) =>
      await fetchWithCookieWithRetry(cj, url, options, fetchTimeout);

    await trace({
      log: "开始更新 maimai 成绩",
      status: "running",
      progress: 0,
    });

    await stage("登录公众号", 10, async () => {
      await doFetch(cj, authUrl, {
        headers: {
          Host: "tgk-wcaime.wahlap.com",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x6307001e)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-User": "?1",
          "Sec-Fetch-Dest": "document",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });

      const result = await doFetch(
        cj,
        "https://maimai.wahlap.com/maimai-mobile/home/"
      );
      const body = await result.text();

      if (body.match("错误")) {
        const errroCode = (body.match(/<div class="p_5 f_14 ">(.*)<\/div>/) ?? [])[1];
        const errorBody = (body.match(/<div class="p_5 f_12 gray break">(.*)<\/div>/) ?? [])[1];
        throw new Error("登录公众号时出现错误 " + errroCode + " " + errorBody);
      }
    });

    const diffNameList = [
      MaimaiDiffType.Basic,
      MaimaiDiffType.Advanced,
      MaimaiDiffType.Expert,
      MaimaiDiffType.Master,
      MaimaiDiffType.ReMaster,
    ];

    const tasks: Promise<any>[] = [];
    [0, 1, 2, 3, 4].forEach((diff) => {
      const name = diffNameList[diff];
      const progress = 9;
      const task = stage(
        `更新 ${name} 难度分数`,
        0,
        async () => {
          if (!diffList.includes(name)) {
            await trace({
              log: `难度 ${name} 更新已跳过`,
              progress: progress * 2,
            });
            return;
          }
          
          const pageType = pageInfo[name].pageType ?? "A";
          const pages : any[] =
                pageType === "A"
              ? [undefined]
              : pageType === "G"
              ? [101, 102, 103, 104, 105, 106]
              : pageType === "W"
              ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
              : [undefined];
          
          await Promise.all(
            pages.map(async (page, index) => {
              const nameWithPage = `${name}` + (`(第 ${index + 1} / ${pages.length} 页)`);
              let body: undefined | string = undefined;

              // Sleep random time to avoid ban
              await sleep(1000 * (diff + index + 1) * 2 + 1000 * 5 * Math.random());

              await stage(`获取 ${nameWithPage} 分数`, progress * 1.0 / pages.length, async () => {
                const result = await fetch(
                  `https://maimai.wahlap.com/maimai-mobile/record/musicSort/search/?search=${pageType + page !== undefined ? `${page}`: ""}&sort=1&playCheck=on&diff=${diff}`
                );

                if (result.url.indexOf("error") !== -1) {
                  const text = await result.text();
                  const errroCode = text.match(/<div class="p_5 f_14 ">(.*)<\/div>/)[1];
                  const errorBody = text.match(
                    /<div class="p_5 f_12 gray break">(.*)<\/div>/
                  )[1];

                  throw Error("Error code " + errroCode + " Error Body" + errorBody);
                }
                
                body = (await result.text())
                  .match(/<html.*>([\s\S]*)<\/html>/)[1]
                  .replace(/\s+/g, " ");
              });

              await stage(
                `上传 ${nameWithPage} 分数至 diving-fish 查分器数据库`,
                progress * 1.0 / pages.length,
                async () => {
                  const uploadResult = await fetch(
                    `${config.pageParserHost}/page`,
                    {
                      method: "post",
                      headers: { "content-type": "text/plain" },
                      body: `<login><u>${username}</u><p>${password}</p></login>${body}`,
                    }
                  );

                  const log = `diving-fish 上传 ${nameWithPage} 分数接口返回消息: ${await uploadResult.text()}`;
                  await trace({ log });
                }
              );
            })
          );
        },
        true
      );
      tasks.push(task);
    });

    await Promise.all(tasks);

    await trace({
      log: "maimai 数据更新完成",
      progress: 100,
      status: "success",
    });
  } catch (err) {
    console.log(err);
  }
};

export enum ChunithmDiffType {
  Basic = "Basic",
  Advanced = "Advanced",
  Expert = "Expert",
  Master = "Master",
  Ultima = "Ultima",
  WorldsEnd = "WorldsEnd",
  Recent = "Recent",
}

const updateChunithmScore = async (
  username: string,
  password: string,
  authUrl: string,
  traceUUID: string,
  diffList: ChunithmDiffType[],
  _pageInfo: any, // TODO: Support paging for chunithm
) => {
  try {
    const trace = useTrace(traceUUID);
    const stage = useStage(trace);
    const cj = new CookieJar();
    const fetch = async (url: string, options: any = undefined, fetchTimeout : number = 1000 * 3 * 60) =>
      await fetchWithCookieWithRetry(cj, url, options, fetchTimeout);

    await trace({
      log: "开始更新 chunithm 成绩",
      status: "running",
      progress: 0,
    });

    await stage("登录公众号", 6.25, async () => {
      const authResult = await doFetch(cj, authUrl, {
        headers: {
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x6307001e)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-User": "?1",
          "Sec-Fetch-Dest": "document",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });

      const body = await authResult.text();
      if (body.match("错误码")) {
        throw new Error("登陆公众号时存在错误码");
      }

      const loginResult = await fetch(
        "https://www.diving-fish.com/api/maimaidxprober/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      if (loginResult.status === 401) {
        throw new Error("登录 http 请求状态码为 401");
      }
    });

    const urls = [
      ["/record/musicGenre/sendBasic", "/record/musicGenre/basic"],
      ["/record/musicGenre/sendAdvanced", "/record/musicGenre/advanced"],
      ["/record/musicGenre/sendExpert", "/record/musicGenre/expert"],
      ["/record/musicGenre/sendMaster", "/record/musicGenre/master"],
      ["/record/musicGenre/sendUltima", "/record/musicGenre/ultima"],
      [null, "/record/worldsEndList/"],
      [null, "/home/playerData/ratingDetailRecent/"],
    ];

    const diffNameList = [
      ChunithmDiffType.Basic,
      ChunithmDiffType.Advanced,
      ChunithmDiffType.Expert,
      ChunithmDiffType.Master,
      ChunithmDiffType.Ultima,
      ChunithmDiffType.WorldsEnd,
      ChunithmDiffType.Recent,
    ];

    const _t = cj.cookies.get("chunithm.wahlap.com").get("_t").value;

    const tasks: Promise<any>[] = [];
    [0, 1, 2, 3, 4, 5, 6].forEach((diff) => {
      const name = diffNameList[diff];
      const progress = 6.25;
      const url = urls[diff];
      const task = stage(
        `更新 ${name} 分数`,
        0,
        async () => {
          if (!diffList.includes(name)) {
            await trace({
              log: `难度 ${name} 更新已跳过`,
              progress: progress * 2,
            });
            return;
          }

          // Sleep random time to avoid ban
          await sleep(1000 * (diff + 1) * 2 + 1000 * 5 * Math.random());

          let resultHtml: string | undefined = undefined;

          await stage(`获取 ${name} 分数`, progress, async () => {
            if (url[0]) {
              await fetch("https://chunithm.wahlap.com/mobile" + url[0], {
                method: "POST",
                body: `genre=99&token=${_t}`,
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              });
            }

            const result = await fetch(
              "https://chunithm.wahlap.com/mobile" + url[1]
            );

            if (result.url.indexOf("error") !== -1) {
              const text = await result.text();
              const errroCode = text.match(/<div class="p_5 f_14 ">(.*)<\/div>/)[1];
              const errorBody = text.match(
                /<div class="p_5 f_12 gray break">(.*)<\/div>/
              )[1];

              throw Error("Error code " + errroCode + " Error Body" + errorBody);
            }
            
            resultHtml = await result.text();
          });

          await stage(
            `上传 ${name} 分数至 diving-fish 查分器数据库`,
            progress,
            async () => {
              const uploadResult = await fetch(
                "https://www.diving-fish.com/api/chunithmprober/player/update_records_html" +
                  (url[1] && url[1].includes("Recent") ? "?recent=1" : ""),
                {
                  method: "POST",
                  body: resultHtml,
                }
              );

              const log = `diving-fish 上传 ${name} 分数接口返回消息: ${await uploadResult.text()}`;
              await trace({ log });
            }
          );
        },
        true
      );
      tasks.push(task);
    });

    await Promise.all(tasks);

    await trace({
      log: "chunithm 数据更新完成",
      progress: 100,
      status: "success",
    });
  } catch (err) {
    console.log(err);
  }
};

export {
  verifyProberAccount,
  updateMaimaiScore,
  updateChunithmScore,
  getAuthUrl,
  getCookieByAuthUrl,
  lock,
};
