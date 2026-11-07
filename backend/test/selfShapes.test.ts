import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { sv } from "../src/aquaSdk.js";
import { ARC_PAIR, planSelfOpen } from "../src/selfCustody.js";
import { assertFunds, SELF_SHAPES, selfBins } from "../src/selfShapes.js";

const SPOT = 2200;
const MAKER = "0x00000000000000000000000000000000c0ffee01" as Address;
const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as Address;
const ROUTER = "0x111111338c5091e8440b67b168bae16a668ac0de" as Address;
const none = { eth: 0n, usdc: 0n };

test("the shapes offered are the full range and the four advanced shapes", () => {
  assert.deepEqual(SELF_SHAPES, ["full", "spot", "curve", "bidask", "hybrid"]);
});

test("a full-range position has no range and one bin", () => {
  assert.deepEqual(selfBins("full", SPOT), { bins: [null], feeBps: 30 });
});

test("spot is one even bin over the chosen range; curve and bid-ask split it; hybrid adds a core", () => {
  assert.equal(selfBins("spot", SPOT, 2000, 2500).bins.length, 1);
  assert.equal(selfBins("curve", SPOT, 1500, 3000).bins.length, 5);
  assert.equal(selfBins("bidask", SPOT, 1500, 3000).bins.length, 5);
  const h = selfBins("hybrid", SPOT, 1100, 4400).bins;
  assert.equal(h.length, 2);
  assert.ok(Math.abs(h[0]!.weight + h[1]!.weight - 1) < 1e-9);
});

test("a Hybrid built by the customer is one even strategy plus three shaped ones, holding exactly the amount", () => {
  for (const mix of ["curve", "bidask"] as const) {
    const bins = selfBins("hybrid", SPOT, 1100, 4400, { mix, side: "both" }).bins;
    assert.equal(bins.length, 4);
    assert.deepEqual([bins[0]!.min, bins[0]!.max, bins[0]!.weight], [1100, 4400, 0.5]);
    assert.ok(Math.abs(bins.reduce((s, b) => s + b!.weight, 0) - 1) < 1e-9);
  }
  const weights = (mix: "curve" | "bidask") => selfBins("hybrid", SPOT, 1100, 4400, { mix, side: "both" }).bins.slice(1).map((b) => b!.weight);
  assert.ok(weights("curve")[1]! > weights("curve")[0]!, "curve leans towards the price");
  assert.ok(weights("bidask")[1]! < weights("bidask")[0]!, "bid-ask leans away from the price");
});

test("a one-sided Hybrid holds only the chosen token", () => {
  const plan = (side: "base" | "quote", min: number, max: number) => {
    const { bins, feeBps } = selfBins("hybrid", SPOT, min, max, { mix: "curve", side });
    return planSelfOpen({ maker: MAKER, amountUsd: 50, bins, feeBps, spot: SPOT, pair: ARC_PAIR, aqua: AQUA, router: ROUTER, allowance: none, owed: none });
  };
  const base = plan("base", SPOT * 1.01, SPOT * 1.3);
  assert.equal(base.need.usdc, 0n);
  assert.ok(base.need.eth > 0n);
  const quote = plan("quote", SPOT * 0.7, SPOT * 0.99);
  assert.equal(quote.need.eth, 0n);
  assert.ok(quote.need.usdc > 0n);
});

test("a one-sided Hybrid is refused, not quietly made two-sided, once the price is inside its range", () => {
  assert.throws(() => selfBins("hybrid", SPOT, SPOT * 0.99, SPOT * 1.3, { mix: "curve", side: "base" }), /above today's price/);
  assert.throws(() => selfBins("hybrid", SPOT, SPOT * 0.7, SPOT * 1.01, { mix: "bidask", side: "quote" }), /below today's price/);
});

test("Hybrid choices are refused on any other shape", () => {
  assert.throws(() => selfBins("spot", SPOT, 2000, 2500, { mix: "curve", side: "base" }), /only apply to a Hybrid/);
  assert.throws(() => selfBins("full", SPOT, undefined, undefined, { mix: "curve", side: "both" }), /only apply to a Hybrid/);
});

test("a Hybrid without choices keeps the older core-and-tail split", () => {
  assert.equal(selfBins("hybrid", SPOT, 1100, 4400).bins.length, 2);
});

test("any amount that can fund every strategy is allowed, with no $5 floor", () => {
  assert.doesNotThrow(() => assertFunds(selfBins("full", SPOT).bins, 0.01));
  assert.doesNotThrow(() => assertFunds(selfBins("spot", SPOT, 2000, 2500).bins, 0.5));
  assert.doesNotThrow(() => assertFunds(selfBins("curve", SPOT, 1500, 3000).bins, 1));
});

test("an amount too small to fund every strategy is refused, not partly opened", () => {
  assert.throws(() => assertFunds(selfBins("full", SPOT).bins, 0.001), /at least \$0\.01/);
  const bins = selfBins("hybrid", SPOT, 1100, 4400, { mix: "curve", side: "both" }).bins;
  assert.throws(() => assertFunds(bins, 0.02), /too small to split across 4 strategies/);
});

test("a range must have a lower price below the upper price", () => {
  assert.throws(() => selfBins("spot", SPOT, 2500, 2000), /lower price below the upper/);
  assert.throws(() => selfBins("spot", SPOT, 2000, 2000), /lower price below the upper/);
  assert.throws(() => selfBins("curve", SPOT), /lower price below the upper/);
});

test("the range keeps to the advanced limits: 90% below to 300% above today's price", () => {
  assert.throws(() => selfBins("spot", SPOT, SPOT * 0.05, SPOT), /90% below/);
  assert.throws(() => selfBins("spot", SPOT, SPOT, SPOT * 5), /can't be above/);
  assert.doesNotThrow(() => selfBins("spot", SPOT, SPOT * 0.1, SPOT * 4));
});

test("a customised range builds into strategies owned by the wallet, like any preset", () => {
  const { bins, feeBps } = selfBins("curve", SPOT, 1800, 2900);
  const out = planSelfOpen({ maker: MAKER, amountUsd: 50, bins, feeBps, spot: SPOT, pair: ARC_PAIR, aqua: AQUA, router: ROUTER, allowance: none, owed: none });
  assert.equal(out.strategies.length, 5);
  for (const s of out.strategies) assert.equal(sv.Order.decode(new sv.HexString(s.order)).maker.toString().toLowerCase(), MAKER);
});
