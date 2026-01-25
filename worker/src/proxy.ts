/**
 * HTTP/HTTPS 代理服务
 * 拦截微信 OAuth 回调以获取 Cookie
 */

import * as http from "http";
import * as net from "net";
import * as url from "url";

import { MaimaiHttpClient, getCookieByAuthUrl } from "./services/index.ts";
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
 * OAuth 回调钩子
 * 拦截认证回调，交换 Cookie 并保存
 */
async function onAuthHook(href: string): Promise<string> {
  console.log("[Proxy] Successfully hook auth request!");

  const target = href.replace("http", "https");
  const key = String(url.parse(target, true).query.r);

  console.log(
    `[Proxy] Found pending auth for key ${key}, exchanging cookie...`,
  );
  try {
    const cj = await getCookieByAuthUrl(target);
    const client = new MaimaiHttpClient(cj);
    const friendCode = await client.getUserFriendCode();

    if (friendCode) {
      console.log(JSON.stringify(cj.toJSON(), null, 2));
      cookieStore.set(friendCode, cj);
      console.log(`[Proxy] Cookie updated successfully for ${friendCode}.`);
      return `${config.redirectUrl}?friendCode=${friendCode}`;
    } else {
      console.error("[Proxy] Failed to get friend code");
      return config.redirectUrl;
    }
  } catch (e) {
    console.error("[Proxy] Failed to exchange cookie", e);
    return config.redirectUrl;
  }
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

  // if (!checkHostInWhiteList(reqUrl.host ?? null)) {
  //   try {
  //     clientRes.writeHead(400, { "Access-Control-Allow-Origin": "*" });
  //     clientRes.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  //   } catch (err) {
  //     console.log("[Proxy] Error:", err);
  //   }
  //   return;
  // }

  // 拦截 http://example.com 请求用于测试代理配置
  if (requestUrl.startsWith("http://example.com")) {
    try {
      console.log("[Proxy] Intercepted test request to example.com");

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
        }),
      );
    } catch (err) {
      console.log("[Proxy] Error handling test request:", err);
      clientRes.writeHead(500, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ success: false, error: String(err) }));
    }
    return;
  }

  // 拦截 OAuth 回调
  if (
    requestUrl.startsWith(
      "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback",
    )
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
