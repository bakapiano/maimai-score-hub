import type { ProxyHttpRequestCase, ProxyHttpRequestContext } from "./index.ts";

export const proxyTestRequestCase: ProxyHttpRequestCase = {
  name: "proxy-test",
  matches: ({ requestUrl }) =>
    requestUrl.startsWith("http://example.com") ||
    requestUrl.startsWith("http://93.184.215.14"),
  handle: handleProxyTestRequest,
};

async function handleProxyTestRequest({
  clientReq,
  clientRes,
  requestUrl,
}: ProxyHttpRequestContext): Promise<void> {
  try {
    console.log("[Proxy] Intercepted test request:", requestUrl);

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
        requestUrl,
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
}
