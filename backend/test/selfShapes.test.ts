import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { sv } from "../src/aquaSdk.js";
import { ARC_PAIR, planSelfOpen } from "../src/selfCustody.js";
import { SELF_SHAPES, selfBins } from "../src/selfShapes.js";

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
