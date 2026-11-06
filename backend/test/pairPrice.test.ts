import { test } from "node:test";
import assert from "node:assert/strict";
import { feedsAgreeWithin, priceFromSqrtX96 } from "../src/pairPrice.js";

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
