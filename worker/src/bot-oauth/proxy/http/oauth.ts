import config from "../../../common/config.ts";
import { botManager } from "../../../common/bots/bot-manager.ts";
import { getCookieByAuthUrl } from "../../../common/maimai/infra/auth.ts";
import { MaimaiClient } from "../../../common/maimai/client.ts";
import { REQUEST_PRIORITY_IMMEDIATE } from "../../../common/maimai/infra/request-priority.ts";
import { runWithRequestContext } from "../../../common/maimai/infra/request-runtime.ts";
import { runtimeState } from "../../common/runtime-state.ts";
import type { ProxyHttpRequestCase, ProxyHttpRequestContext } from "./index.ts";

const AUTH_EXCHANGE_FRIEND_CODE_TIMEOUT_MS = 90_000;
const OAUTH_CALLBACK_PREFIX =
  "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback";
export const OAUTH_CONNECT_HOST = "tgk-wcaime.wahlap.com:80";
const OAUTH_CALLBACK_HOSTNAME = "tgk-wcaime.wahlap.com";
const OAUTH_CALLBACK_PATH_PREFIX = "/wc_auth/oauth/callback";

export const oauthCallbackRequestCase: ProxyHttpRequestCase = {
  name: "oauth-callback",
  matches: ({ clientReq, requestUrl }) =>
    isOAuthCallbackGetRequest(clientReq.method, requestUrl),
  handle: handleOAuthCallbackRequest,
};

export function isOAuthCallbackGetRequest(
  method: string | undefined,
  requestUrl: string,
): boolean {
  if (method?.toUpperCase() !== "GET") return false;

  try {
    const parsed = new URL(requestUrl);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === OAUTH_CALLBACK_HOSTNAME &&
      (parsed.port === "" || parsed.port === "80") &&
      parsed.pathname.startsWith(OAUTH_CALLBACK_PATH_PREFIX)
    );
  } catch {
    return requestUrl.startsWith(OAUTH_CALLBACK_PREFIX);
  }
}

async function handleOAuthCallbackRequest({
  clientRes,
  clientReq,
  requestUrl,
}: ProxyHttpRequestContext): Promise<void> {
  try {
    if (!isOAuthCallbackGetRequest(clientReq.method, requestUrl)) {
      clientRes.writeHead(404);
      clientRes.end();
      return;
    }

    const redirectResult = await onAuthHook(requestUrl);
    clientRes.writeHead(302, { location: redirectResult });
    clientRes.end();
  } catch (err) {
    console.log("[Proxy] Error:", err);
  }
}

export async function onAuthHook(href: string): Promise<string> {
  console.log("[Proxy] Successfully hook auth request!");

  const target = href.replace(/^http:/, "https:");
  console.log("[Proxy] Starting background bot auth exchange...");

  runtimeState.startAuth();
  void exchangeBotAuthUrl(target).finally(() => runtimeState.finishAuth());

  return runtimeState.redirectUrl || `http://127.0.0.1:${config.port}/`;
}

async function exchangeBotAuthUrl(authUrl: string): Promise<void> {
  const timeoutSentinel: unique symbol = Symbol(
    "auth-exchange-timeout",
  ) as never;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const hardTimeout = new Promise<typeof timeoutSentinel>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve(timeoutSentinel),
      AUTH_EXCHANGE_FRIEND_CODE_TIMEOUT_MS,
    );
  });

  try {
    const cookieJar = await getCookieByAuthUrl(authUrl);
    const client = new MaimaiClient(cookieJar);
    const friendCodeResult = await Promise.race([
      runWithRequestContext(
        { requestPriority: REQUEST_PRIORITY_IMMEDIATE },
        () => client.profiles.getUserFriendCode(),
      ),
      hardTimeout,
    ]);

    if (friendCodeResult === timeoutSentinel) {
      console.error(
        `[OAuth] Cookie exchange aborted: getUserFriendCode exceeded ${AUTH_EXCHANGE_FRIEND_CODE_TIMEOUT_MS / 1000}s`,
      );
      return;
    }

    if (!friendCodeResult) {
      console.error("[OAuth] Failed to get friend code");
      return;
    }

    console.log(JSON.stringify(cookieJar.toJSON(), null, 2));
    botManager._set(friendCodeResult, cookieJar);
    console.log(`[OAuth] Cookie updated successfully for ${friendCodeResult}.`);
  } catch (err) {
    console.error("[OAuth] Failed to exchange cookie", err);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
