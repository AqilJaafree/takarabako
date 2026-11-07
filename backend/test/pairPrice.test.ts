import { test } from "node:test";
import assert from "node:assert/strict";
import { candlesFromCoinbase, feedsAgreeWithin, priceFromSqrtX96 } from "../src/pairPrice.js";

// Coinbase's rows, newest first: [time, low, high, open, close, volume].
const NOW = 1_794_010_000;
const row = (t: number, c: number) => [t, c - 0.001, c + 0.001, c, c, 100];

test("Coinbase's rows become candles, oldest first", () => {
  const candles = candlesFromCoinbase([row(NOW - 100, 1.114), row(NOW - 3700, 1.113)], NOW);
  assert.deepEqual(candles.map((c) => c.t), [NOW - 3700, NOW - 100]);
  assert.deepEqual(candlesFromCoinbase([[NOW, 1.11, 1.12, 1.113, 1.115, 100]], NOW), [{ t: NOW, o: 1.113, h: 1.12, l: 1.11, c: 1.115 }]);
});

test("only the last week of candles is kept", () => {
  const rows = Array.from({ length: 300 }, (_, i) => row(NOW - i * 3600, 1.114));
  assert.equal(candlesFromCoinbase(rows, NOW).length, 168);
});

test("a feed that has stopped updating gives no candles, not an old chart", () => {
  // EURC-USD on Coinbase looks healthy but its newest candle is from August 2024
  assert.deepEqual(candlesFromCoinbase([row(1_724_943_600, 1.107)], NOW), []);
});

test("an answer that is not candles gives none", () => {
  assert.deepEqual(candlesFromCoinbase({ message: "NotFound" }, NOW), []);
  assert.deepEqual(candlesFromCoinbase([["bad"]], NOW), []);
  assert.deepEqual(candlesFromCoinbase([], NOW), []);
});

test("the pool's sqrt price is turned into USDC per EURC", () => {
  // the live pool read tick -1085 / sqrtPriceX96 for 1 USDC = 0.89724 EURC, so 1 EURC = $1.11453
  const sqrt = BigInt(Math.floor(Math.sqrt(0.89724) * 2 ** 96));
  assert.ok(Math.abs(priceFromSqrtX96(sqrt) - 1.11453) < 0.0005);
});

test("two prices within 1.5% agree, further apart do not", () => {
  assert.ok(feedsAgreeWithin(1.11453, 1.1165)); // the real gap between the Arc pool and the ECB rate: 0.18%
  assert.ok(feedsAgreeWithin(1.1, 1.116)); // 1.45%
  assert.ok(!feedsAgreeWithin(1.1, 1.12)); // 1.8%
  assert.ok(!feedsAgreeWithin(1.0, 1.2));
});

test("a zero or missing price never agrees", () => {
  assert.ok(!feedsAgreeWithin(0, 1.1));
  assert.ok(!feedsAgreeWithin(1.1, 0));
  assert.ok(!feedsAgreeWithin(-1, 1));
});
