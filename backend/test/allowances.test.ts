import { test } from "node:test";
import assert from "node:assert/strict";
import { allowanceAction } from "../src/allowances.js";

const MAX = 2n ** 256n - 1n;

test("an allowance that covers the need with margin is left alone", () => {
  assert.deepEqual(allowanceAction(2_000n, 1_000n), { kind: "none" });
  assert.deepEqual(allowanceAction(1_500n, 1_000n), { kind: "none" }); // exactly the raise threshold
  assert.deepEqual(allowanceAction(8_000n, 1_000n), { kind: "none" }); // exactly the lower threshold
});

test("a short allowance is raised to twice the need", () => {
  assert.deepEqual(allowanceAction(0n, 1_000n), { kind: "set", amount: 2_000n, why: "raise" });
  assert.deepEqual(allowanceAction(1_499n, 1_000n), { kind: "set", amount: 2_000n, why: "raise" });
});

test("the old unlimited approval is brought down to a sized one", () => {
  assert.deepEqual(allowanceAction(MAX, 1_000n), { kind: "set", amount: 2_000n, why: "lower" });
  assert.deepEqual(allowanceAction(8_001n, 1_000n), { kind: "set", amount: 2_000n, why: "lower" });
});

test("with nothing shipped and nothing to ship, an old allowance is revoked, and zero stays zero", () => {
  assert.deepEqual(allowanceAction(MAX, 0n), { kind: "set", amount: 0n, why: "lower" });
  assert.deepEqual(allowanceAction(0n, 0n), { kind: "none" });
});

test("when the need could not be read in full it never lowers, but still raises", () => {
  assert.deepEqual(allowanceAction(MAX, 1_000n, false), { kind: "none" });
  assert.deepEqual(allowanceAction(100n, 1_000n, false), { kind: "set", amount: 2_000n, why: "raise" });
});
