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
import { timingSafeEqual } from "crypto";
import { testCookieExpired } from "./cookie.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/**
 * Basic auth 中间件。
 *
 * - 若 ADMIN_PASSWORD 未配置：放行（保留 dev 行为）
 * - 否则：必须携带 `Authorization: Basic base64(admin:password)`，
 *   失败一律 401 + `WWW-Authenticate`。浏览器会自动弹凭证窗口，
 *   并在同源后续请求上带回该头，故页面内的 fetch 不需要改动。
 *
 * 用 timingSafeEqual 等长比对，避免 timing 侧信道。
 */
const ADMIN_REALM = 'Basic realm="maimai-worker-admin"';

function requireAdminAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const expected = config.httpProxy.adminPassword;
  if (!expected) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("basic ")) {
    res
      .status(401)
      .set("WWW-Authenticate", ADMIN_REALM)
      .type("text/plain")
      .send("401 Unauthorized\n");
    return;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    res.status(401).set("WWW-Authenticate", ADMIN_REALM).end();
    return;
  }

  const sep = decoded.indexOf(":");
  if (sep < 0) {
    res.status(401).set("WWW-Authenticate", ADMIN_REALM).end();
    return;
  }
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  const a = Buffer.from(pass, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (user !== "admin" || a.length !== b.length || !timingSafeEqual(a, b)) {
    res
      .status(401)
      .set("WWW-Authenticate", ADMIN_REALM)
      .type("text/plain")
      .send("401 Unauthorized\n");
    return;
  }

  next();
}

/**
 * 健康检查 —— 不加 auth：
 *   - GitHub Actions deploy-worker.yml 用它做 health probe
 *   - 静态页面在用户登录前也轮询它显示后端状态
 * 仅返回 `{status:"ok"}`，无敏感信息。
 */
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * 静态页面 —— 加 auth：浏览器弹 Basic auth 窗
 */
app.get("/", requireAdminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "../static/index.html"));
});

/**
 * 获取认证 URL —— 加 auth（防止被滥用为 SSRF/重定向）
 */
app.get("/api/auth", requireAdminAuth, async (req, res) => {
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
 *   —— 加 auth：响应里包含明文 cookie 值，绝对敏感
 */
app.get("/api/status", requireAdminAuth, async (_req, res) => {
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
      res.json({
        expired: false,
        friendCode,
        cookie: cookieStore.extractValues(cj),
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * 获取 Job Service 配置 —— 加 auth：只是不希望随便人探到后端 URL
 */
app.get("/api/job-service/config", requireAdminAuth, (_req, res) => {
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
