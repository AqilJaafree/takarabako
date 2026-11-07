import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, baseAmount, binsFor, sqrtBounds, valueUsd, TIERS, type PairTokens } from "../src/aquaMath.js";

const PAIR: PairTokens = {
  eth: { address: "0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282", decimals: 18n },
  usdc: { address: "0x6cc5f175810e61A56508049f0527BC75EB7e77e4", decimals: 6n },
};
const close = (a: number, b: number, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test("spot is one even bin covering the range", () => {
  assert.deepEqual(binsFor("spot", 2000, 3000, 2500), [{ min: 2000, max: 3000, weight: 1 }]);
});

test("curve and bid-ask split the range into contiguous bins whose weights sum to 1", () => {
  for (const shape of ["curve", "bidask"] as const) {
    const bins = binsFor(shape, 1000, 4000, 2000);
    assert.equal(bins.length, 5);
    close(bins.reduce((s, b) => s + b.weight, 0), 1, 1e-9);
    assert.equal(bins[0]!.min, 1000);
    assert.equal(bins[4]!.max, 4000);
    for (let i = 1; i < bins.length; i++) close(bins[i]!.min, bins[i - 1]!.max, 1e-6);
  }
});

test("curve puts the most liquidity next to the current price; bid-ask puts it farthest away", () => {
  const spot = 2500;
  const curve = binsFor("curve", 1250, 5000, spot);
  const bidask = binsFor("bidask", 1250, 5000, spot);
  const nearest = curve.findIndex((b) => spot >= b.min && spot <= b.max);
  assert.equal(curve.indexOf(curve.reduce((a, b) => (b.weight > a.weight ? b : a))), nearest);
  assert.equal(bidask.indexOf(bidask.reduce((a, b) => (b.weight < a.weight ? b : a))), nearest);
});

test("a range below the price is USDC only (a bid); above it is ETH only (an ask)", () => {
  const bid = allocate(1000, { min: 1500, max: 2400 }, 2500, PAIR);
  assert.equal(bid.eth, 0n);
  assert.equal(bid.usdc, 1000_000000n);
  const ask = allocate(1000, { min: 2600, max: 4000 }, 2500, PAIR);
  assert.equal(ask.usdc, 0n);
  close(Number(ask.eth) / 1e18, 0.4, 1e-6);
});

test("a two-sided range is worth the requested USD at spot", () => {
  const a = allocate(1000, { min: 2000, max: 3000 }, 2500, PAIR);
  assert.ok(a.eth > 0n && a.usdc > 0n);
  close(valueUsd(a.eth, a.usdc, 2500, PAIR), 1000, 0.05);
});

test("full range is 50/50 by value", () => {
  const a = allocate(1000, null, 2500, PAIR);
  close(Number(a.usdc) / 1e6, 500);
  close((Number(a.eth) / 1e18) * 2500, 500, 0.01);
});

test("sqrt bounds come back lowest first and grow with price", () => {
  const [lo, hi] = sqrtBounds(2000, 3000, PAIR);
  assert.ok(lo < hi);
  const [lo2] = sqrtBounds(2500, 3000, PAIR);
  assert.ok(lo2 > lo);
});

test("tiers get narrower as risk rises", () => {
  assert.equal(TIERS.low.rangePct, null);
  assert.ok(TIERS.medium.rangePct! > TIERS.high.rangePct!);
});

test("hybrid is a ±8% core holding 70% of the money plus the whole range as a tail", () => {
  const bins = binsFor("hybrid", 1000, 4000, 2000);
  assert.equal(bins.length, 2);
  close(bins[0]!.min, 1840, 1e-6);
  close(bins[0]!.max, 2160, 1e-6);
  close(bins[0]!.weight, 0.7, 1e-9);
  assert.deepEqual([bins[1]!.min, bins[1]!.max], [1000, 4000]);
  close(bins[1]!.weight, 0.3, 1e-9);
});

test("hybrid clips its core to the range, and has none when the range is away from the price", () => {
  const clipped = binsFor("hybrid", 1900, 4000, 2000);
  close(clipped[0]!.min, 1900, 1e-6); // the range's own floor, not 1840
  close(clipped[0]!.max, 2160, 1e-6);
  assert.deepEqual(binsFor("hybrid", 3000, 4000, 2000), [{ min: 3000, max: 4000, weight: 1 }]);
  assert.deepEqual(binsFor("hybrid", 1000, 1500, 2000), [{ min: 1000, max: 1500, weight: 1 }]);
});

test("a hybrid position is worth what was put in, and both bins hold both tokens around the price", () => {
  const spot = 2000;
  const bins = binsFor("hybrid", 1000, 4000, spot);
  let total = 0;
  for (const b of bins) {
    const { eth, usdc } = allocate(1000 * b.weight, b, spot, PAIR);
    assert.ok(eth > 0n && usdc > 0n, "a range around the price holds both tokens");
    total += valueUsd(eth, usdc, spot, PAIR);
  }
  close(total, 1000, 0.5);
});

const shaped = (bins: Array<{ weight: number }>) => bins.slice(1).map((b) => b.weight);

test("a customer-built Hybrid weights its shaped half 5:1, leaving half the money in Spot", () => {
  const curve = binsFor("hybrid", 1600, 2500, 2000, undefined, { mix: "curve", side: "both" });
  const [low, mid, high] = shaped(curve) as [number, number, number];
  close(curve[0]!.weight, 0.5, 1e-9);
  close(low + mid + high, 0.5, 1e-9);
  close(mid / low, 5, 1e-9);
  close(mid / high, 5, 1e-9);

  const bidask = binsFor("hybrid", 1600, 2500, 2000, undefined, { mix: "bidask", side: "both" });
  const [bLow, bMid, bHigh] = shaped(bidask) as [number, number, number];
  close(bLow / bMid, 5, 1e-9);
  close(bHigh / bMid, 5, 1e-9);
});

test("a customer-built Hybrid's shape runs from the price outwards when the range is one-sided", () => {
  const above = shaped(binsFor("hybrid", 2020, 2400, 2000, undefined, { mix: "curve", side: "base" }));
  assert.ok(above[0]! > above[1]! && above[1]! > above[2]!, "curve: most nearest the price");
  close(above[0]! / above[2]!, 5, 1e-9);
  const below = shaped(binsFor("hybrid", 1600, 1980, 2000, undefined, { mix: "bidask", side: "quote" }));
  assert.ok(below[0]! > below[1]! && below[1]! > below[2]!, "bid-ask: most furthest from the price");
  close(below[0]! / below[2]!, 5, 1e-9);
});

test("plain Curve and Bid-Ask keep their gentler weights", () => {
  const w = binsFor("curve", 1000, 4000, 2000).map((b) => b.weight);
  assert.ok(Math.max(...w) / Math.min(...w) < 5);
});

test("a base token's amount follows its own decimals", () => {
  assert.equal(baseAmount(1_500_000_000_000_000_000n, PAIR), 1.5);
  const eurc = { ...PAIR, eth: { address: PAIR.eth.address, decimals: 6n } };
  assert.equal(baseAmount(1_500_000n, eurc), 1.5);
});

test("a customer-built Hybrid around the price is worth what was put in, holding both tokens", () => {
  const spot = 2000;
  for (const mix of ["curve", "bidask"] as const) {
    const bins = binsFor("hybrid", 1600, 2400, spot, undefined, { mix, side: "both" });
    assert.equal(bins.length, 4);
    let total = 0;
    let eth = 0n;
    let usdc = 0n;
    for (const b of bins) {
      const a = allocate(1000 * b.weight, b, spot, PAIR);
      total += valueUsd(a.eth, a.usdc, spot, PAIR);
      eth += a.eth;
      usdc += a.usdc;
    }
    close(total, 1000, 0.5);
    assert.ok(eth > 0n && usdc > 0n);
  }
});

test("a base token with fewer than 9 decimals (EURC, 6) is sized correctly, not truncated to zero", () => {
  const eurc = { eth: { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", decimals: 6n }, usdc: { address: "0x3600000000000000000000000000000000000000", decimals: 6n } };
  const spot = 1.1165;
  // a range entirely above the price is base token only: $100 of it is 100 / 1.1165 EURC
  const above = allocate(100, { min: 1.2, max: 1.3 }, spot, eurc);
  assert.equal(above.usdc, 0n);
  assert.ok(Math.abs(Number(above.eth) / 1e6 - 100 / spot) < 0.001, `got ${above.eth}`);
  // full range is half and half
  const full = allocate(100, null, spot, eurc);
  assert.ok(Math.abs(Number(full.eth) / 1e6 - 50 / spot) < 0.001);
  assert.equal(full.usdc, 50_000_000n);
  // and the 18-decimal case is unchanged
  const weth = { eth: { address: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", decimals: 18n }, usdc: eurc.usdc };
  assert.ok(Math.abs(Number(allocate(100, { min: 2500, max: 3000 }, 2200, weth).eth) / 1e18 - 100 / 2200) < 1e-6);
});
