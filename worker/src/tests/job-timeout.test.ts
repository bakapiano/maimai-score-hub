import assert from "node:assert/strict";
import test from "node:test";

import { TIMEOUTS } from "../common/maimai/constants.ts";

test("DXNet jobs have a 30 minute hard timeout", () => {
  assert.equal(TIMEOUTS.jobHardTimeout, 30 * 60_000);
});
