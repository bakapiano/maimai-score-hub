import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import {
  parseHasReceivedFriendRequest,
  parseHasSentFriendRequest,
  parseIsFriendFromSearchPage,
} from "../common/maimai/parsers/friend-request-parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const receivedRequestFixture = resolve(
  here,
  "fixtures/friend-search-received-request-634142510810999.html",
);
const sentRequestFixture = resolve(
  here,
  "fixtures/friend-search-sent-request-634142510810999.html",
);
const friendFixture = resolve(
  here,
  "fixtures/friend-search-friend-634142510810999.html",
);
const noneFixture = resolve(
  here,
  "fixtures/friend-search-none-634142510810999.html",
);

const receivedRequestHtml = await readFile(receivedRequestFixture, "utf-8");
const sentRequestHtml = await readFile(sentRequestFixture, "utf-8");
const friendHtml = await readFile(friendFixture, "utf-8");
const noneHtml = await readFile(noneFixture, "utf-8");

assert.equal(parseHasReceivedFriendRequest(receivedRequestHtml), true);
assert.equal(parseHasReceivedFriendRequest(sentRequestHtml), false);
assert.equal(parseHasReceivedFriendRequest(friendHtml), false);
assert.equal(parseHasReceivedFriendRequest(noneHtml), false);

assert.equal(parseHasSentFriendRequest(sentRequestHtml), true);
assert.equal(parseHasSentFriendRequest(receivedRequestHtml), false);
assert.equal(parseHasSentFriendRequest(friendHtml), false);
assert.equal(parseHasSentFriendRequest(noneHtml), false);

assert.equal(parseIsFriendFromSearchPage(friendHtml), true);
assert.equal(parseIsFriendFromSearchPage(receivedRequestHtml), false);
assert.equal(parseIsFriendFromSearchPage(sentRequestHtml), false);
assert.equal(parseIsFriendFromSearchPage(noneHtml), false);

console.log("Pinned friend search request-state markers.");
