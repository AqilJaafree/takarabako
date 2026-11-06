import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { _resetPriceCaches, ethUsd } from "../src/aqua.js";

// One module-level price cache, so these run in order: first a live price,
// then the feed goes down and time passes.
test("money-moving callers refuse a stale price; display callers keep it", async (t) => {
  _resetPriceCaches();
  let now = 1_000_000_000_000;
  t.mock.method(Date, "now", () => now);

  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: { amount: "2200.50" } })));
  assert.equal(await ethUsd(), 2200.5);

  mock.method(globalThis, "fetch", async () => {
    throw new Error("feed down");
  });
  now += 2 * 60_000; // two minutes old, feed down
  assert.equal(await ethUsd(), 2200.5, "a display with no limit still gets the last price");
  assert.equal(await ethUsd({ maxStaleMs: 5 * 60_000 }), 2200.5, "two minutes is fresh enough to move money");

  now += 10 * 60_000; // twelve minutes old
  assert.equal(await ethUsd(), 2200.5, "a display never fails");
  await assert.rejects(ethUsd({ maxStaleMs: 5 * 60_000 }), /too old to move money at/);

  mock.restoreAll();
});

const feeds = (coinbase: string | Error, kraken: string | Error) =>
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const u = String(url);
    const v = u.includes("coinbase") ? coinbase : kraken;
    if (v instanceof Error) throw v;
    return new Response(u.includes("coinbase") ? JSON.stringify({ data: { amount: v } }) : JSON.stringify({ error: [], result: { XETHZUSD: { c: [v, "1"] } } }));
  });

test("a verified price is returned when the second feed agrees", async () => {
  _resetPriceCaches();
  feeds("2240.00", "2241.50");
  assert.equal(await ethUsd({ verify: true }), 2240);
  mock.restoreAll();
});

test("a verified price is refused when the feeds disagree", async () => {
  _resetPriceCaches();
  feeds("2240.00", "2400.00"); // Kraken 7% higher
  await assert.rejects(ethUsd({ verify: true }), (err: Error & { status?: number }) => /feeds disagree/.test(err.message) && err.status === 503);
  mock.restoreAll();
});

test("an unreachable second feed does not stop a withdrawal", async () => {
  _resetPriceCaches();
  feeds("2240.00", new Error("kraken down"));
  assert.equal(await ethUsd({ verify: true }), 2240);
  mock.restoreAll();
});

test("without verify, only the first feed is used and a disagreeing second one is ignored", async () => {
  _resetPriceCaches();
  feeds("2240.00", "9999.00");
  assert.equal(await ethUsd(), 2240);
  mock.restoreAll();
});
