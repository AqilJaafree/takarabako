import { test } from "node:test";
import assert from "node:assert/strict";

// With no SELF_EXTRA_PAIRS only a chain's first pair is offered: a new pair is a real-money product of
// its own, so it has to be turned on by name.
process.env.SELF_CUSTODY_ARC = "1";
delete process.env.SELF_EXTRA_PAIRS;
const { selfNet, selfPairsInfo } = await import("../src/selfChain.js");

test("extra pairs are off unless named", () => {
  assert.deepEqual(selfNet("arc").pairKeys, ["weth"]);
  assert.deepEqual(selfPairsInfo("arc").map((p) => p.key), ["weth"]);
  assert.throws(() => selfNet("arc", "eurc"), (e: Error & { status?: number }) => e.status === 404);
});
