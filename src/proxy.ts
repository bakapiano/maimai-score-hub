import * as http from "http";
import * as net from "net";
import * as url from "url";

import { GameType, MaimaiDiffType, PageInfo, getCookieByAuthUrl, updateChunithmScore, updateMaimaiScore } from "./crawler.js";
import { delValue, getValue, setValue } from "./db.js";

import { HTTPParser } from "http-parser-js";
import { appendLog } from "./trace.js";
import { appendTask } from "./web.js";
import config from "./config.js";
import { v4 as genUUID } from "uuid"
import { saveCookie } from "./bot/cookie.js";

const proxyServer = http.createServer(httpOptions);

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

function checkHostInWhiteList(target: string | null) {
  if (!target) return false;
  target = target.split(":")[0];
  return WHITE_LIST.find((value) => value === target) !== undefined;
}

async function onAuthHook(href: string) {
  console.log("Successfully hook auth request!");

  const protocol = config.dev ? "http" : "https"
  const target = href.replace("http", "https");
  const key = String(url.parse(target, true).query.r);
  const value = await getValue(key);
  
  if (value === undefined || key === "count") {
    return `${protocol}://${config.host}/#/error`;
  }

  // Save cookie to local path
  if (value.local === true && config.bot.enable) {
    const cj = await getCookieByAuthUrl(target);
    await saveCookie(cj)
    return `${protocol}://${config.host}/#/error`;
  }

  const { username, password, callbackHost, diffList, pageInfo } = value;
  const baseHost = callbackHost || config.host
  const errorPageUrl = `${protocol}://${baseHost}/#/error`
  const traceUUID = genUUID()
  const tracePageUrl = `${protocol}://${baseHost}/#/trace/${traceUUID}/`

  delValue(key);

  // Save data with traceUUID as key to support retry
  await setValue(traceUUID, value);

  console.log(username, password, baseHost)
  if (!username || !password) {
    return errorPageUrl;
  }
  
  await appendLog(traceUUID, "");

  const data = {
    username,
    password,
    authUrl: target,
    traceUUID,
    diffList,
    pageInfo,
  }

  if (target.includes('maimai-dx')) {
    appendTask(data, GameType.maimai)
  } else if (target.includes('chunithm')) {
    appendTask(data, GameType.chunithm)
  } else { // ongeki? hahaha
    return errorPageUrl
  }
  return tracePageUrl;
}

// handle http proxy requests
async function httpOptions(clientReq : any, clientRes: any) {
  clientReq.on("error", (e: any) => {
    console.log("client socket error: " + e);
  });

  // console.log(clientReq.url)
  var reqUrl = url.parse(clientReq.url);
  if (!checkHostInWhiteList(reqUrl.host)) {
    try {
      clientRes.statusCode = 400;
      clientRes.writeHead(400, {
        "Access-Control-Allow-Origin": "*",
      });
      clientRes.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch (err) {
      console.log(err);
    }
    return;
  }

  if (
    reqUrl.href.startsWith(
      "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback"
    )
  ) {
    try {
      const redirectResult = await onAuthHook(reqUrl.href);
      clientRes.writeHead(302, { location: redirectResult });
      clientRes.statusCode = 302;
      clientRes.end();
    } catch (err) {
      console.log(err);
    }

    return;
  }

  var options = {
    hostname: reqUrl.hostname,
    port: reqUrl.port,
    path: reqUrl.path,
    method: clientReq.method,
    headers: clientReq.headers,
  };

  // create socket connection on behalf of client, then pipe the response to client response (pass it on)
  var serverConnection = http.request(options, function (res) {
    clientRes.writeHead(res.statusCode, res.headers);
    res.pipe(clientRes);
  });

  serverConnection.on("error", (e) => {
    console.log("server connection error: " + e);
  });

  clientReq.pipe(serverConnection);
}

// handle https proxy requests (CONNECT method)
proxyServer.on("connect", (clientReq : any, clientSocket : any, head : any) => {
  clientSocket.on("error", (e: any) => {
    console.log("client socket error: " + e);
    clientSocket.end();
  });

  var reqUrl = url.parse("https://" + clientReq.url);
  // console.log('proxy for https request: ' + reqUrl.href + '(path encrypted by ssl)');

  if (
    !checkHostInWhiteList(reqUrl.host) ||
    reqUrl.href.startsWith("https://maimai.wahlap.com/") ||
    reqUrl.href.startsWith("https://chunithm.wahlap.com/")
  ) {
    try {
      clientSocket.statusCode = 400;
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch (err) {
      console.log(err);
    }
    return;
  }

  if (reqUrl.host === 'tgk-wcaime.wahlap.com:80') {
    clientSocket.write("HTTP/" +
      clientReq.httpVersion +
      " 200 Connection Established\r\n" +
      "Proxy-agent: Node.js-Proxy\r\n" +
      "\r\n",
      "UTF-8", () => {
        const parser: any = new HTTPParser('REQUEST');
        parser[HTTPParser.kOnHeadersComplete] = async (info: any) => {
          try {
            const redirectResult = await onAuthHook(`http://tgk-wcaime.wahlap.com${info.url}`);
            clientSocket.end(`HTTP/1.1 302 Found\r\nLocation: ${redirectResult}\r\n\r\n`);
          }
          catch(err) {
            console.log(err)
          }
        };

        clientSocket.on('data', (chunk: any) => {
          parser.execute(chunk);
        });
      });

    return;
  }

  var options = {
    port: reqUrl.port,
    host: reqUrl.hostname,
  };

  // create socket connection for client, then pipe (redirect) it to client socket
  var serverSocket = net.connect(options as any, () => {
    clientSocket.write(
      "HTTP/" +
      clientReq.httpVersion +
      " 200 Connection Established\r\n" +
      "Proxy-agent: Node.js-Proxy\r\n" +
      "\r\n",
      "UTF-8",
      () => {
        // creating pipes in both ends
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      }
    );
  });

  serverSocket.on("error", (e) => {
    console.log("forward proxy server connection error: " + e);
    clientSocket.end();
  });
});

proxyServer.on("clientError", (err, clientSocket: any) => {
  console.log("client error: " + err);
  clientSocket.statusCode = 400;
  clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

export { proxyServer as proxy };