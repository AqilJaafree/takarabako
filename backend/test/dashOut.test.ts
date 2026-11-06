import { test } from "node:test";
import assert from "node:assert/strict";
import { maxFill, planFills, type Candidate, type Quoter } from "../src/dashOut.js";

// A fake strategy: pays `rate` USDC units per base unit, up to `cap` USDC units, and its price falls by
// `slip` (fraction per base unit sold) as it fills, like a curve. Quotes beyond its USDC return null.
const cand = (id: string, usdc: bigint): Candidate => ({ order: id, hash: id, maker: "0xmaker", owner: null, usdc });
const pool = (rates: Record<string, { rate: number; cap: bigint }>): Quoter => async (c, amount) => {
  const p = rates[c.order]!;
  const out = BigInt(Math.floor(Number(amount) * p.rate));
  return out > p.cap ? null : out;
};

test("a fill that fits is taken whole", async () => {
  const q = pool({ a: { rate: 2, cap: 1_000_000n } });
  assert.equal(await maxFill(q, cand("a", 1_000_000n), 1000n), 1000n);
});

test("a fill that is too big is cut to the most the strategy can pay", async () => {
  const q = pool({ a: { rate: 2, cap: 1000n } }); // pays 2 per unit, holds 1000: takes up to 500
  const got = await maxFill(q, cand("a", 1000n), 10_000n);
  assert.ok(got <= 500n && got >= 499n, `got ${got}`);
  assert.ok((await q(cand("a", 1000n), got)) !== null, "what it returns must itself quote");
});

test("nothing fits: zero", async () => {
  const q: Quoter = async () => null;
  assert.equal(await maxFill(q, cand("a", 1n), 1000n), 0n);
});

test("the best-priced strategy is filled first, then the next for what is left", async () => {
  const q = pool({ low: { rate: 1.9, cap: 10_000_000n }, high: { rate: 2.0, cap: 1000n }, mid: { rate: 1.95, cap: 10_000_000n } });
  const r = await planFills(q, [cand("low", 1n), cand("high", 1n), cand("mid", 1n)], 2000n);
  assert.equal(r.fills[0]!.candidate.order, "high");
  assert.equal(r.fills[1]!.candidate.order, "mid");
  assert.equal(r.filled, 2000n);
  assert.equal(r.fills.reduce((s, f) => s + f.amountIn, 0n), 2000n);
  assert.equal(r.out, r.fills.reduce((s, f) => s + f.amountOut, 0n));
  assert.ok(r.fills.every((f) => f.amountOut > 0n));
});

test("not enough liquidity: it fills what it can and says how much is left", async () => {
  const q = pool({ a: { rate: 2, cap: 600n }, b: { rate: 1, cap: 100n } });
  const r = await planFills(q, [cand("a", 1n), cand("b", 1n)], 10_000n);
  assert.ok(r.filled < 10_000n);
  assert.ok(r.filled >= 399n, `filled ${r.filled}`); // a takes ~300, b takes ~100
  assert.equal(r.fills.reduce((s, f) => s + f.amountIn, 0n), r.filled);
});

test("no strategy takes the token: nothing is planned", async () => {
  const r = await planFills(async () => null, [cand("a", 1n), cand("b", 1n)], 1000n);
  assert.equal(r.fills.length, 0);
  assert.equal(r.filled, 0n);
  assert.equal(r.out, 0n);
});

test("every fill is re-quoted at its final size, so the payout is exact", async () => {
  const seen: Array<[string, bigint]> = [];
  const q: Quoter = async (c, a) => {
    seen.push([c.order, a]);
    return a * 2n;
  };
  const r = await planFills(q, [cand("a", 1n)], 1000n);
  assert.deepEqual(r.fills.map((f) => [f.amountIn, f.amountOut]), [[1000n, 2000n]]);
  assert.ok(seen.some(([, a]) => a === 1000n));
});
