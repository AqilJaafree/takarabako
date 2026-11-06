import { test } from "node:test";
import assert from "node:assert/strict";
import { backingShortfall, feedsAgree, parseKrakenEthUsd, GuardError } from "../src/guards.js";

test("two feeds within 2% agree, further apart they do not", () => {
  assert.equal(feedsAgree(2240, 2241), true);
  assert.equal(feedsAgree(2200, 2244), true); // exactly 2%
  assert.equal(feedsAgree(2200, 2245), false);
  assert.equal(feedsAgree(2240, 1120), false); // a halved price
});

test("a zero or negative price never agrees with anything", () => {
  assert.equal(feedsAgree(0, 0), false);
  assert.equal(feedsAgree(2240, 0), false);
  assert.equal(feedsAgree(-1, 2240), false);
});

test("reads the last trade price from Kraken's ticker", () => {
  const body = { error: [], result: { XETHZUSD: { c: ["2241.07000", "0.027"] } } };
  assert.equal(parseKrakenEthUsd(body), 2241.07);
});

test("rejects a Kraken answer with no usable price", () => {
  assert.throws(() => parseKrakenEthUsd({ error: ["EQuery:Unknown asset pair"], result: {} }), /no ETH price/);
  assert.throws(() => parseKrakenEthUsd(null), /no ETH price/);
  assert.throws(() => parseKrakenEthUsd({ result: { XETHZUSD: { c: ["0"] } } }), /no ETH price/);
});

const A = (eth: bigint, usdc: bigint) => ({ eth, usdc });

test("a treasury that holds more than every strategy could pay out is not short", () => {
  assert.deepEqual(backingShortfall(A(100n, 100n), A(40n, 40n), A(10n, 10n), A(0n, 0n)), A(0n, 0n));
  assert.deepEqual(backingShortfall(A(50n, 50n), A(40n, 40n), A(10n, 10n), A(0n, 0n)), A(0n, 0n)); // exactly enough
});

test("it reports how much of each token is missing", () => {
  assert.deepEqual(backingShortfall(A(30n, 100n), A(40n, 40n), A(10n, 10n), A(0n, 0n)), A(20n, 0n));
  assert.deepEqual(backingShortfall(A(100n, 30n), A(40n, 40n), A(10n, 10n), A(0n, 0n)), A(0n, 20n));
});

test("USD about to arrive from the customer's vault counts towards the cover", () => {
  assert.deepEqual(backingShortfall(A(100n, 30n), A(40n, 40n), A(10n, 10n), A(0n, 20n)), A(0n, 0n));
});

test("a guard error carries the 503 the error handler sends", () => {
  const e = new GuardError("nope");
  assert.equal(e.status, 503);
  assert.ok(e instanceof Error);
});
