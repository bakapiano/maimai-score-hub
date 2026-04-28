/**
 * HTTP API 服务
 * 提供 REST API 接口
 */

import { GameType, getAuthUrl } from "./services/index.ts";
import { cookieStore, runtimeState } from "./state.ts";

import config from "./config.ts";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { testCookieExpired } from "./cookie.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/**
 * 健康检查
 */
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * 静态页面
 */
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../static/index.html"));
});

/**
 * 获取认证 URL
 */
app.get("/api/auth", async (req, res) => {
  try {
    // 前端传入当前页面 URL，auth 完成后重定向回去
    const redirectUrl = req.query.redirectUrl as string | undefined;
    if (redirectUrl) {
      runtimeState.redirectUrl = redirectUrl;
    }

    const href = await getAuthUrl(GameType.maimai);
    console.log(href);
    res.json({ authUrl: href });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

/**
 * 检查 Cookie 状态（单 Bot 模式）
 */
app.get("/api/status", async (_req, res) => {
  try {
    if (runtimeState.isAuthOngoing) {
      res.json({ status: "ok", authOngoing: true, expired: false });
      return;
    }

    const friendCodes = cookieStore.getAllBotFriendCodes();
    if (friendCodes.length === 0) {
      res.json({ expired: true });
      return;
    }

    const friendCode = friendCodes[0];
    const cj = cookieStore.get(friendCode)!;
    const expired = await testCookieExpired(cj);

    if (expired) {
      res.json({ expired: true, friendCode });
    } else {
      // NOTE: 不要把 cookie 值放进响应里。前端只读 authOngoing/expired/friendCode；
      // 把明文 bot session 暴露在公网 :3999 上是个真洞（任何人就能冒充 bot）。
      res.json({
        expired: false,
        friendCode,
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * 启动 API 服务
 */
export function startServer(): void {
  app.listen(config.port, () => {
    console.log(`V2 Web Service listening on port ${config.port}`);
  });
}
