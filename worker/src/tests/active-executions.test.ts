import assert from "node:assert/strict";
import test from "node:test";

import { ActiveExecutionRegistry } from "../worker/runtime/active-executions.ts";

test("overlapping stalled deliveries keep independent active registrations", () => {
  const registry = new ActiveExecutionRegistry();
  const first = registry.begin("job-e1", "background");
  const replacement = registry.begin("job-e1", "background");

  registry.end(first);
  registry.abort("job-e1", new Error("lock lost"));

  assert.equal(first.controller.signal.aborted, false);
  assert.equal(replacement.controller.signal.aborted, true);
});
