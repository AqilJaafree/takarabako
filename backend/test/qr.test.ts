import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWalletFromQr } from "../src/qr.js";

const A = "0x9205DcCC081D896edeAB423d88665660d61d5bfE";

test("plain address, lowercased", () => {
  assert.equal(parseWalletFromQr(A), A.toLowerCase());
});
test("EIP-681 with chain id and query", () => {
  assert.equal(parseWalletFromQr(`ethereum:${A}@11155111?value=0`), A.toLowerCase());
});
test("surrounding whitespace", () => {
  assert.equal(parseWalletFromQr(`  ${A}\n`), A.toLowerCase());
});
test("junk is rejected", () => {
  for (const bad of ["", "hello", "0x1234", `bitcoin:${A}`, `${A}00`]) assert.equal(parseWalletFromQr(bad), null);
});
