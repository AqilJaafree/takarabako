import { test } from "node:test";
import assert from "node:assert/strict";
import type { PreviewBin } from "./types";
import { liquidityProfile } from "./liquidityProfile";

const SPOT = 2000;
const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

/// A bin holding liquidity `l` over a range, with the tokens a concentrated range holds at the price.
function bin(min: number, max: number, l: number, spot = SPOT): PreviewBin {
  const eth = spot < max ? l * (1 / Math.sqrt(Math.max(spot, min)) - 1 / Math.sqrt(max)) : 0;
  const usdc = spot > min ? l * (Math.sqrt(Math.min(spot, max)) - Math.sqrt(min)) : 0;
  return { min, max, weight: 1, usd: eth * spot + usdc, eth, usdc };
}

test("overlapping strategies add up instead of hiding each other", () => {
  const p = liquidityProfile([bin(1000, 4000, 100), bin(1500, 1800, 50)], SPOT);
  assert.deepEqual(p.map((s) => [s.min, s.max]), [[1000, 1500], [1500, 1800], [1800, 2000], [2000, 4000]]);
  close(p[0]!.depth, 100);
  close(p[1]!.depth, 150);
  close(p[2]!.depth, 100);
  close(p[3]!.depth, 100);
});

test("slices below the price hold only the quote token, and above it only the base token", () => {
  for (const s of liquidityProfile([bin(1000, 4000, 100)], SPOT)) {
    if (s.max <= SPOT) {
      assert.equal(s.side, "usdc");
      assert.equal(s.eth, 0);
    } else {
      assert.equal(s.side, "eth");
      assert.equal(s.usdc, 0);
    }
  }
});

test("no tokens are lost or invented by slicing", () => {
  const bins = [bin(1000, 4000, 100), bin(1000, 1500, 40), bin(1500, 2500, 90), bin(2500, 4000, 30)];
  const p = liquidityProfile(bins, SPOT);
  close(p.reduce((t, s) => t + s.eth, 0), bins.reduce((t, b) => t + b.eth, 0));
  close(p.reduce((t, s) => t + s.usdc, 0), bins.reduce((t, b) => t + b.usdc, 0));
  close(p.reduce((t, s) => t + s.usd, 0), bins.reduce((t, b) => t + b.usd, 0));
});

test("a one-sided range is one colour, and its shape still shows", () => {
  const p = liquidityProfile([bin(1000, 1900, 100), bin(1000, 1300, 20), bin(1300, 1600, 40), bin(1600, 1900, 80)], SPOT);
  assert.ok(p.every((s) => s.side === "usdc"));
  [120, 140, 180].forEach((depth, i) => close(p[i]!.depth, depth));
});

test("a range at the price is not given a zero-width slice", () => {
  const p = liquidityProfile([bin(2000, 3000, 10)], SPOT);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.side, "eth");
});

test("a bin with no range, or no money, draws nothing", () => {
  assert.deepEqual(liquidityProfile([{ min: null, max: null, weight: 1, usd: 100, eth: 1, usdc: 1 }], SPOT), []);
  assert.deepEqual(liquidityProfile([{ min: 1000, max: 2000, weight: 1, usd: 0, eth: 0, usdc: 0 }], SPOT), []);
});
