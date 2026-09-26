import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToString } from "viem";
import { currencyBytes, fromTkUnits, kioskIdBytes, toTkUnits } from "../src/cashReceipt.js";

test("kiosk ids are right-padded bytes32, like Solidity's bytes32(\"...\")", () => {
  const id = kioskIdBytes("tokyo-01");
  assert.equal(id.length, 2 + 64);
  assert.equal(hexToString(id, { size: 32 }), "tokyo-01");
  assert.ok(id.endsWith("00"));
});

test("currency codes are bytes3", () => {
  assert.equal(currencyBytes("myr"), "0x4d5952");
  assert.equal(currencyBytes("USD"), "0x555344");
});

test("USD amounts round-trip through tkCASH's 6 decimals without float drift", () => {
  assert.equal(toTkUnits(21.37), "21370000");
  assert.equal(toTkUnits(0.1 + 0.2), "300000");
  assert.equal(fromTkUnits("21370000"), 21.37);
});
