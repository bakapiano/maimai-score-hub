import type * as http from "http";
import type * as url from "url";

import { forwardRequestCase } from "./forward.ts";
import { oauthCallbackRequestCase } from "./oauth.ts";
import { proxyTestRequestCase } from "./proxy-test.ts";

export interface ProxyHttpRequestContext {
  clientReq: http.IncomingMessage;
  clientRes: http.ServerResponse;
  requestUrl: string;
  reqUrl: url.UrlWithStringQuery;
}

export interface ProxyHttpRequestCase {
  name: string;
  matches(ctx: ProxyHttpRequestContext): boolean;
  handle(ctx: ProxyHttpRequestContext): Promise<void> | void;
}

const HTTP_REQUEST_CASES: ProxyHttpRequestCase[] = [
  proxyTestRequestCase,
  oauthCallbackRequestCase,
  forwardRequestCase,
];

export function findHttpRequestCase(
  ctx: ProxyHttpRequestContext,
): ProxyHttpRequestCase {
  return HTTP_REQUEST_CASES.find((item) => item.matches(ctx))!;
}
