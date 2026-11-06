import { test } from "node:test";
import assert from "node:assert/strict";
import { CCTP_DOMAIN, cctpDomain, cctpSupported, addressToBytes32, parseAttestationResponse, estimateMinutes } from "../src/cctp.js";

test("the chains use Circle's CCTP domains", () => {
  assert.equal(CCTP_DOMAIN.sepolia, 0);
  assert.equal(CCTP_DOMAIN["arc-testnet"], 26);
});

test("an address becomes a left-padded bytes32 mint recipient", () => {
  assert.equal(
    addressToBytes32("0xAbCdEf0000000000000000000000000000000001"),
    "0x000000000000000000000000abcdef0000000000000000000000000000000001",
  );
});

test("an attestation is ready only when Circle says complete and signs", () => {
  assert.deepEqual(parseAttestationResponse(null), { ready: false, reason: "not indexed yet" });
  assert.deepEqual(parseAttestationResponse({ messages: [] }), { ready: false, reason: "not indexed yet" });
  assert.deepEqual(parseAttestationResponse({ messages: [{ status: "pending_confirmations", attestation: "PENDING", message: "0x" }] }), { ready: false, reason: "pending_confirmations" });
  assert.deepEqual(parseAttestationResponse({ messages: [{ status: "complete", attestation: "0xabcd", message: "0x1234" }] }), { ready: true, message: "0x1234", attestation: "0xabcd" });
});

test("waiting from Sepolia is longer than from Arc", () => {
  assert.ok(estimateMinutes("sepolia") > estimateMinutes("arc-testnet"));
});

test("Hedera has no CCTP route", () => {
  assert.equal(cctpSupported("hedera-testnet"), false);
  assert.equal(cctpSupported("sepolia"), true);
  assert.throws(() => cctpDomain("hedera-testnet"), /no CCTP route/);
});
