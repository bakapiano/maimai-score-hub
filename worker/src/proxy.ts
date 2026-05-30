/**
 * HTTP/HTTPS 代理服务
 * 拦截微信 OAuth 回调以获取 Cookie
 */

import * as http from "http";
import * as net from "net";
import * as url from "url";
import { timingSafeEqual } from "crypto";

import {
  MaimaiHttpClient,
  getCookieByAuthUrl,
  reportBotStatus,
} from "./services/index.ts";
import { cookieStore, runtimeState } from "./state.ts";

import { HTTPParser } from "http-parser-js";
import config from "./config.ts";

const proxyServer = http.createServer(handleHttpRequest);

/**
 * 白名单域名
 */
const WHITE_LIST = [
  "127.0.0.1",
  "localhost",
  "tgk-wcaime.wahlap.com",
  "maimai.bakapiano.com",
  "www.diving-fish.com",
  "open.weixin.qq.com",
  "weixin110.qq.com",
  "res.wx.qq.com",
  "libs.baidu.com",
  "maimai.bakapiano.online",
  "api.maimai.bakapiano.online",
  "api.maimai.bakapiano.com",
].concat(config.host);

/**
 * 检查域名是否在白名单中
 */
function checkHostInWhiteList(target: string | null): boolean {
  return true;

  if (!target) return false;
  if (config.dev) return true;
  target = target.split(":")[0];
  return WHITE_LIST.includes(target);
}

/**
 * 校验 Proxy-Authorization 头里的 Basic 凭证。
 *
 * 行为：
 *   - 若未配置 ADMIN_PASSWORD，所有请求放行（向后兼容）。
 *   - 若已配置，未携带 / 用户名错 / 密码错 → 返回 false，调用方需回 407。
 *   - 用户名约定为 "admin"。
 *   - 密码使用 timingSafeEqual 等长比对，避免 timing 侧信道。
 */
function isProxyAuthValid(headerValue: string | undefined): boolean {
  const expected = config.httpProxy.adminPassword;
  if (!expected) return true; // auth disabled

  if (!headerValue || !headerValue.toLowerCase().startsWith("basic ")) {
    return false;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(headerValue.slice(6).trim(), "base64").toString(
      "utf8",
    );
  } catch {
    return false;
  }

  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (user !== "admin") return false;

  const a = Buffer.from(pass, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const PROXY_AUTH_REALM = 'Basic realm="maimai-worker-proxy"';

/**
 * OAuth 回调钩子
 * 拦截认证回调，立即返回重定向 URL，后台异步交换 Cookie
 */
async function onAuthHook(href: string): Promise<string> {
  console.log("[Proxy] Successfully hook auth request!");

  const target = href.replace("http", "https");
  const key = String(url.parse(target, true).query.r);

  console.log(
    `[Proxy] Found pending auth for key ${key}, starting background cookie exchange...`,
  );

  // 标记认证开始
  runtimeState.startAuth();

  // 后台异步执行 cookie 交换，不阻塞代理响应
  (async () => {
    // 硬超时 90s — getCookieByAuthUrl 内部 fetch-cookie 不保证响应
    // AbortSignal，加一个最外层的 Promise.race 兜底，防止 IIFE 永挂
    // 而 startAuth/finishAuth 状态错乱。
    const timeoutSentinel: unique symbol = Symbol("auth-iife-timeout") as never;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const hardTimeout = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), 90_000);
    });
    try {
      const cj = await getCookieByAuthUrl(target);
      const client = new MaimaiHttpClient(cj);
      const friendCodeResult = await Promise.race([
        client.getUserFriendCode(),
        hardTimeout,
      ]);
      if (friendCodeResult === timeoutSentinel) {
        console.error(
          "[Proxy] Cookie exchange aborted: getUserFriendCode exceeded 90s",
        );
      } else if (friendCodeResult) {
        const friendCode = friendCodeResult;
        console.log(JSON.stringify(cj.toJSON(), null, 2));
        cookieStore.set(friendCode, cj);
        cookieStore.markValid(friendCode);
        console.log(`[Proxy] Cookie updated successfully for ${friendCode}.`);
        // 登录成功后立即上报 Bot 状态
        reportBotStatus().catch((err) =>
          console.error("[Proxy] Bot status report after login failed:", err),
        );
      } else {
        console.error("[Proxy] Failed to get friend code");
      }
    } catch (e) {
      console.error("[Proxy] Failed to exchange cookie", e);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      runtimeState.finishAuth();
    }
  })();

  // 立即返回重定向 URL，不等待 cookie 交换完成
  // 优先使用前端传入的 URL，否则回退到默认的 worker 首页
  const redirect =
    runtimeState.redirectUrl || `http://127.0.0.1:${config.port}/`;
  return redirect;
}

/**
 * 处理 HTTP 代理请求
 */
async function handleHttpRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  clientReq.on("error", (e: Error) => {
    console.log("[Proxy] Client socket error: " + e);
  });

  const requestUrl = clientReq.url || "";
  const reqUrl = url.parse(requestUrl);

  // OAuth 回调 / 测试探针不要求 auth，所有其他请求必须带 Proxy-Authorization
  const isAuthExempt =
    requestUrl.startsWith("http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback") ||
    requestUrl.startsWith("http://example.com") ||
    requestUrl.startsWith("http://93.184.215.14");

  if (
    !isAuthExempt &&
    !isProxyAuthValid(clientReq.headers["proxy-authorization"] as string | undefined)
  ) {
    try {
      clientRes.writeHead(407, {
        "Proxy-Authenticate": PROXY_AUTH_REALM,
        "Content-Type": "text/plain",
        Connection: "close",
      });
      clientRes.end("407 Proxy Authentication Required\r\n");
    } catch (err) {
      console.log("[Proxy] Failed to send 407:", err);
    }
    return;
  }

  // if (!checkHostInWhiteList(reqUrl.host ?? null)) {
  //   try {
  //     clientRes.writeHead(400, { "Access-Control-Allow-Origin": "*" });
  //     clientRes.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  //   } catch (err) {
  //     console.log("[Proxy] Error:", err);
  //   }
  //   return;
  // }

  // 拦截 http://example.com 或 93.184.215.14 请求用于测试代理配置
  if (
    requestUrl.startsWith("http://example.com") ||
    requestUrl.startsWith("http://93.184.215.14")
  ) {
    try {
      console.log("[Proxy] Intercepted test request:", requestUrl);

      // 处理 CORS 预检请求
      if (clientReq.method === "OPTIONS") {
        clientRes.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        });
        clientRes.end();
        return;
      }

      clientRes.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      clientRes.end(
        JSON.stringify({
          success: true,
          message: "Proxy is configured correctly",
          timestamp: new Date().toISOString(),
          requestUrl: requestUrl,
        }),
      );
    } catch (err) {
      console.log("[Proxy] Error handling test request:", err);
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
      }
      clientRes.end(JSON.stringify({ success: false, error: String(err) }));
    }
    return;
  }

  // 拦截 OAuth 回调
  if (
    requestUrl.startsWith("http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback")
  ) {
    try {
      const redirectResult = await onAuthHook(requestUrl);
      clientRes.writeHead(302, { location: redirectResult });
      clientRes.end();
    } catch (err) {
      console.log("[Proxy] Error:", err);
    }
    return;
  }

  // 转发普通请求
  const options: http.RequestOptions = {
    hostname: reqUrl.hostname,
    port: reqUrl.port ? parseInt(reqUrl.port, 10) : undefined,
    path: reqUrl.path,
    method: clientReq.method,
    headers: clientReq.headers,
  };

  const serverConnection = http.request(options, (res) => {
    clientRes.writeHead(res.statusCode || 200, res.headers);
    res.pipe(clientRes);
  });

  serverConnection.on("error", (e) => {
    console.log("[Proxy] Server connection error: " + e);
  });

  clientReq.pipe(serverConnection);
}

/**
 * 处理 HTTPS 代理请求（CONNECT 方法）
 */
proxyServer.on(
  "connect",
  (clientReq: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on("error", (e: Error) => {
      console.log("[Proxy] Client socket error: " + e);
      clientSocket.end();
    });

    const reqUrl = url.parse("https://" + clientReq.url);

    // CONNECT 隧道一律要求 auth（OAuth 截取走的是 host:80 的 CONNECT，
    // 由真人浏览器发起，浏览器会把代理凭证发上来，所以也走同一条 auth 路径）
    if (
      !isProxyAuthValid(
        clientReq.headers["proxy-authorization"] as string | undefined,
      )
    ) {
      try {
        clientSocket.end(
          "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            `Proxy-Authenticate: ${PROXY_AUTH_REALM}\r\n` +
            "Connection: close\r\n" +
            "\r\n",
        );
      } catch (err) {
        console.log("[Proxy] Failed to send 407 on CONNECT:", err);
      }
      return;
    }

    // // 检查白名单，排除舞萌/中二网站的直接 HTTPS 连接
    // if (
    //   !checkHostInWhiteList(reqUrl.host ?? null) ||
    //   (reqUrl.href &&
    //     (reqUrl.href.startsWith("https://maimai.wahlap.com/") ||
    //       reqUrl.href.startsWith("https://chunithm.wahlap.com/")))
    // ) {
    //   try {
    //     clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    //   } catch (err) {
    //     console.log("[Proxy] Error:", err);
    //   }
    //   return;
    // }

    // 特殊处理 OAuth 回调
    if (reqUrl.host === "tgk-wcaime.wahlap.com:80") {
      clientSocket.write(
        "HTTP/" +
          clientReq.httpVersion +
          " 200 Connection Established\r\n" +
          "Proxy-agent: Node.js-Proxy\r\n" +
          "\r\n",
        "utf-8",
        () => {
          const parser = new HTTPParser("REQUEST");
          (parser as any)[HTTPParser.kOnHeadersComplete] = async (info: {
            url: string;
          }) => {
            try {
              const redirectResult = await onAuthHook(
                `http://tgk-wcaime.wahlap.com${info.url}`,
              );
              clientSocket.end(
                `HTTP/1.1 302 Found\r\nLocation: ${redirectResult}\r\n\r\n`,
              );
            } catch (err) {
              console.log("[Proxy] Error:", err);
            }
          };

          clientSocket.on("data", (chunk: Buffer) => {
            parser.execute(chunk);
          });
        },
      );
      return;
    }

    // 转发 HTTPS 连接
    const options = {
      port: reqUrl.port ? parseInt(reqUrl.port, 10) : 443,
      host: reqUrl.hostname || undefined,
    };

    const serverSocket = net.connect(options, () => {
      clientSocket.write(
        "HTTP/" +
          clientReq.httpVersion +
          " 200 Connection Established\r\n" +
          "Proxy-agent: Node.js-Proxy\r\n" +
          "\r\n",
        "utf-8",
        () => {
          serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        },
      );
    });

    serverSocket.on("error", (e) => {
      console.log("[Proxy] Forward proxy server connection error: " + e);
      clientSocket.end();
    });
  },
);

proxyServer.on("clientError", (err, clientSocket) => {
  const rawPacket = (err as { rawPacket?: Buffer }).rawPacket;
  const rawPreview = rawPacket
    ? rawPacket.toString("utf8", 0, 200)
    : "<no rawPacket>";
  console.log("[Proxy] Client error: " + err);
  console.log("[Proxy] Client error raw: " + rawPreview);

  // 检查 socket 是否可写，避免在已关闭的 socket 上写入
  if (!clientSocket.destroyed && clientSocket.writable) {
    try {
      (clientSocket as net.Socket).end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch (e) {
      console.log("[Proxy] Failed to send error response:", e);
    }
  }
});

export { proxyServer as proxy };
