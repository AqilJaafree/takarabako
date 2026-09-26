import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, POLICY, type PolicyContext } from "../src/policy.js";

const ctx: PolicyContext = { fundedToday: 0, mintedToday: 0, knownKiosks: ["tokyo-01"] };

test("APY must stay within 0–2000 bps and be whole", () => {
  assert.deepEqual(checkPolicy("set_apy", { bps: 450 }, ctx), { ok: true });
  assert.deepEqual(checkPolicy("set_apy", { bps: 0 }, ctx), { ok: true });
  assert.deepEqual(checkPolicy("set_apy", { bps: POLICY.maxApyBps }, ctx), { ok: true });
  assert.equal(checkPolicy("set_apy", { bps: 5000 }, ctx).ok, false); // "raise APY to 50%"
  assert.equal(checkPolicy("set_apy", { bps: -1 }, ctx).ok, false);
  assert.equal(checkPolicy("set_apy", { bps: 4.5 }, ctx).ok, false);
});

test("yield-reserve funding counts what was already funded today", () => {
  assert.deepEqual(checkPolicy("fund_yield_reserve", { amount: 200 }, ctx), { ok: true });
  assert.deepEqual(checkPolicy("fund_yield_reserve", { amount: 500 }, ctx), { ok: true });
  assert.equal(checkPolicy("fund_yield_reserve", { amount: 501 }, ctx).ok, false);
  const later = checkPolicy("fund_yield_reserve", { amount: 200 }, { ...ctx, fundedToday: 400 });
  assert.equal(later.ok, false);
  assert.match((later as { reason: string }).reason, /at most 100 more/);
  assert.equal(checkPolicy("fund_yield_reserve", { amount: 0 }, ctx).ok, false);
});

test("float minting has a daily cap", () => {
  assert.deepEqual(checkPolicy("mint_usdc_float", { amount: 10_000 }, ctx), { ok: true });
  assert.equal(checkPolicy("mint_usdc_float", { amount: 1 }, { ...ctx, mintedToday: 10_000 }).ok, false);
});

test("pausing needs a known kiosk and a reason", () => {
  assert.deepEqual(checkPolicy("pause_kiosk", { kioskId: "tokyo-01", reason: "count mismatch" }, ctx), { ok: true });
  assert.equal(checkPolicy("pause_kiosk", { kioskId: "nowhere", reason: "x" }, ctx).ok, false);
  assert.equal(checkPolicy("pause_kiosk", { kioskId: "tokyo-01", reason: " " }, ctx).ok, false);
});

test("unknown actions (like unpausing) are rejected", () => {
  assert.equal(checkPolicy("unpause_kiosk" as never, {}, ctx).ok, false);
});
