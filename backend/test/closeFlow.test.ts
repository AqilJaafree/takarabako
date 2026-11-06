import { test } from "node:test";
import assert from "node:assert/strict";
import { floorMicros, payoutStep, PAYOUT_PENDING } from "../src/closeFlow.js";

const HASH = `0x${"ab".repeat(32)}`;

test("no payout recorded yet means send it", () => {
  assert.deepEqual(payoutStep(null), { kind: "send" });
});

test("a recorded transaction hash is verified, not sent again", () => {
  assert.deepEqual(payoutStep(HASH), { kind: "verify", hash: HASH });
});

test("a payout that was started but never recorded blocks an automatic retry", () => {
  const step = payoutStep(PAYOUT_PENDING);
  assert.equal(step.kind, "blocked");
  assert.match((step as { reason: string }).reason, /could pay twice/);
});

test("anything else in close_tx is refused rather than guessed at", () => {
  assert.equal(payoutStep("0x123").kind, "blocked");
  assert.equal(payoutStep("").kind, "blocked");
});

test("payouts round down to a micro-dollar and never go negative", () => {
  assert.equal(floorMicros(12.3456789), 12.345678);
  assert.equal(floorMicros(0.0000004), 0);
  assert.equal(floorMicros(-5), 0);
});
