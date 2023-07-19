import "express-async-errors";

import {
  appendQueue,
  delValue,
  getCount,
  getValue,
  increaseCount,
  removeFromQueueByFriendCode,
  setValue,
} from "./db.js";
import { getAuthUrl, verifyProberAccount } from "./crawler.js";
import { getTrace, useTrace } from "./trace.js";

import bodyParser from "body-parser";
import config from "./config.js";
import cors from "cors";
import { exec } from "child_process";
import express from "express";
import { v4 as genUUID } from "uuid";
import { parse } from "url";
import { queueLock } from "./bot/work.js";

const app = express();
app.use(cors());

const jsonParser = bodyParser.json();

async function serve(
  serverReq: any,
  serverRes: any,
  data: any,
  redirect: boolean
) {
  let { username, password, callbackHost, type, diffList, allDiff } = data;

  diffList = diffList?.split(",");

  console.log(username, password, callbackHost, type, diffList, allDiff);

  if (!username || !password) {
    serverRes.status(400).send("用户名或密码不能为空！");
    return;
  }

  // Update maimai dx by default
  if (!type) {
    type = "maimai-dx";
  }

  if (!["maimai-dx", "chunithm"].includes(type)) {
    serverRes.status(400).send("不支持的查分类型！");
    return;
  }

  // 兼容旧版 allDiff 短链接
  if (allDiff === true) {
    diffList =
      type == "maimai-dx"
        ? ["Basic", "Advanced", "Expert", "Master", "Re:Master"]
        : [
            "Basic",
            "Advanced",
            "Expert",
            "Master",
            "Ultima",
            "WorldsEnd",
            "Recent",
          ];
  } else if (allDiff === false) {
    diffList =
      type == "maimai-dx"
        ? ["Expert", "Master", "Re:Master"]
        : ["Expert", "Master", "Ultima", "WorldsEnd", "Recent"];
  }

  // Update all diff or not
  if (diffList === undefined || diffList === null) {
    diffList =
      type == "maimai-dx"
        ? ["Expert", "Master", "Re:Master"]
        : ["Expert", "Master", "Ultima", "WorldsEnd", "Recent"];
  }

  if (
    !(await verifyProberAccount(username, password)) &&
    username !== "bakapiano666" // 为 app 保留的用户名
  ) {
    serverRes.status(400).send("查分器用户名或密码错误！");
    return;
  }

  if (callbackHost === undefined) {
    callbackHost = config.host;
  }

  const href = await getAuthUrl(type);

  const resultUrl = parse(href, true);
  const { redirect_uri } = resultUrl.query;
  const key = String(parse(String(redirect_uri), true).query.r);

  await setValue(key, { username, password, callbackHost, diffList });
  // setTimeout(() => delValue(key), 1000 * 60 * 5);

  increaseCount();

  redirect === true
    ? serverRes.redirect(href)
    : serverRes.status(200).send(href);
}

app.post("/auth", jsonParser, async (serverReq: any, serverRes: any) => {
  return await serve(serverReq, serverRes, serverReq.body, false);
});

app.get("/shortcut", async (serverReq: any, serverRes: any) => {
  return await serve(serverReq, serverRes, serverReq.query, true);
});

app.get("/trace", async (serverReq: any, serverRes: any) => {
  const { uuid } = serverReq.query;
  !uuid
    ? serverRes.status(400).send("请提供uuid")
    : serverRes.send(await getTrace(String(uuid)));
});

app.get("/count", async (_serverReq: any, serverRes: any) => {
  const count = getCount();
  serverRes.status(200).send({ count });
});

if (config.wechatLogin.enable) {
  const validateToken = (serve: any) => {
    return async (serverReq: any, serverRes: any) => {
      const { token } = serverReq.query;
      if (token !== config.authToken) {
        serverRes.status(400).send("Invalid token");
        return;
      }
      await serve(serverReq, serverRes);
    };
  };

  // Use for local login
  app.get(
    "/token",
    validateToken(async (serverReq: any, serverRes: any) => {
      let { type } = serverReq.query;

      const href = await getAuthUrl(type);

      const resultUrl = parse(href, true);
      const { redirect_uri } = resultUrl.query;
      const key = parse(String(redirect_uri), true).query.r;

      await setValue(String(key), { local: true });

      serverRes.redirect(href);
    })
  );

  // Trigger a wechat login
  app.get(
    "/trigger",
    validateToken(async (_serverReq: any, serverRes: any) => {
      exec(config.wechatLogin.cmd2Execute);
      serverRes.status(200).send("Triggered");
    })
  );
}

if (config.bot.enable) {
  app.post("/bot", jsonParser, async (req: any, res: any) => {
    const { username, password, friendCode } = req.body;

    if (!username || !password || !friendCode) {
      res.status(400);
      return;
    }

    if (!(await verifyProberAccount(username, password))) {
      res.status(400).send("查分器用户名或密码错误！");
      return;
    }

    if (queueLock) {
      res.status(400).send("Bot 同时使用人数过多，请稍后再试！");
      return;
    }

    // Clean up old one
    removeFromQueueByFriendCode(friendCode);
    await delValue(friendCode);

    const traceUUID = genUUID();
    const protocol = config.dev ? "http" : "https";
    const tracePageUrl = `${protocol}://${config.host}/#/trace/${traceUUID}/`;
    const trace = useTrace(traceUUID);

    await trace({
      log: "请等待 bot 主动发起好友请求(需等待1-5分钟)/或主动向 bot 发送好友请求(好友号码:413252453611467)来继续...",
      status: "running",
      progress: 0,
      time: new Date().getTime(),
    });
    
    appendQueue({
      username,
      password,
      friendCode,
      traceUUID,
      createTime: Date.now(),
    });

    res.status(200).send(tracePageUrl);
  });
}

app.use(express.static("static"));

app.use((err: any, req: any, res: any, next: any) => {
  console.error(err.stack);
  res.status(500).send("500 Internal Server Error");
});

export { app as server };
