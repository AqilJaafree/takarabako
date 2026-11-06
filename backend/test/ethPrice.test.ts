import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ethUsd } from "../src/aqua.js";

// One module-level price cache, so these run in order: first a live price,
// then the feed goes down and time passes.
test("money-moving callers refuse a stale price; display callers keep it", async (t) => {
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
