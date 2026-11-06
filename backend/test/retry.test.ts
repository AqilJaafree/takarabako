import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRpcLag, retryOnLag } from "../src/retry.js";

const lag = () => new Error("Execution reverted for an unknown reason.");

test("a reverted estimate, a missing block and a missing trie node count as lag", () => {
  assert.equal(looksLikeRpcLag(lag()), true);
  assert.equal(looksLikeRpcLag(new Error("block not found")), true);
  assert.equal(looksLikeRpcLag(new Error("missing trie node abc")), true);
});

test("real failures do not count as lag", () => {
  assert.equal(looksLikeRpcLag(new Error("insufficient funds for gas * price + value")), false);
  assert.equal(looksLikeRpcLag(new Error("nonce too low")), false);
  assert.equal(looksLikeRpcLag("boom"), false);
});

test("retries lag errors until the call succeeds", async () => {
  let calls = 0;
  const out = await retryOnLag(async () => {
    calls++;
    if (calls < 3) throw lag();
    return "ok";
  }, { delayMs: 0 });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("a real failure is thrown at once, without retrying", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnLag(async () => {
      calls++;
      throw new Error("insufficient funds");
    }, { delayMs: 0 }),
    /insufficient funds/,
  );
  assert.equal(calls, 1);
});

test("a persistent lag error is thrown after the last try", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnLag(async () => {
      calls++;
      throw lag();
    }, { tries: 4, delayMs: 0 }),
    /reverted/,
  );
  assert.equal(calls, 4);
});
