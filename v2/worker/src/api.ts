/**
 * HTTP API 服务
 * 提供 REST API 接口
 */

import express from "express";
import { fileURLToPath } from "url";
import path from "path";

import config from "./config.ts";
import { getAuthUrl, GameType } from "./services/index.ts";
import { cookieStore } from "./state.ts";
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
app.get("/api/auth", async (_req, res) => {
  try {
    const href = await getAuthUrl(GameType.maimai);
    res.json({ authUrl: href });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

/**
 * 检查 Cookie 状态
 */
app.get("/api/status", async (req, res) => {
  const friendCode = req.query.friendCode as string;
  if (!friendCode) {
    res.status(400).json({ error: "friendCode is required" });
    return;
  }

  try {
    const cj = cookieStore.get(friendCode);
    if (!cj) {
      res.json({ expired: true });
      return;
    }

    const expired = await testCookieExpired(cj);

    if (expired) {
      res.json({ expired: true });
    } else {
      res.json({ expired: false, cookie: cookieStore.extractValues(cj) });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * 获取 Job Service 配置
 */
app.get("/api/job-service/config", (_req, res) => {
  res.json({ baseUrl: config.jobService?.baseUrl ?? "" });
});

/**
 * 启动 API 服务
 */
export function startServer(): void {
  app.listen(config.port, () => {
    console.log(`V2 Web Service listening on port ${config.port}`);
  });
}
