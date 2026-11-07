import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDepositChain } from "../src/depositChain.js";

const ready = ["sepolia", "arc-testnet", "hedera-testnet"] as const;

test("the customer's chosen chain wins over the kiosk's", () => {
  assert.equal(resolveDepositChain({ customer: "hedera-testnet", kiosk: "sepolia", ready, fallback: "sepolia" }), "hedera-testnet");
  assert.equal(resolveDepositChain({ customer: "arc-testnet", kiosk: "hedera-testnet", ready, fallback: "sepolia" }), "arc-testnet");
});

test("with no choice, the note goes to the kiosk's chain", () => {
  assert.equal(resolveDepositChain({ customer: null, kiosk: "arc-testnet", ready, fallback: "sepolia" }), "arc-testnet");
});

test("a choice that is no longer available falls back instead of losing the note", () => {
  const onlySepolia = ["sepolia"] as const;
  assert.equal(resolveDepositChain({ customer: "hedera-testnet", kiosk: "sepolia", ready: onlySepolia, fallback: "sepolia" }), "sepolia");
  assert.equal(resolveDepositChain({ customer: "hedera-testnet", kiosk: "arc-testnet", ready: onlySepolia, fallback: "sepolia" }), "sepolia");
});

test("values that are not chains are ignored", () => {
  assert.equal(resolveDepositChain({ customer: "arc", kiosk: "nonsense", ready, fallback: "sepolia" }), "sepolia");
  assert.equal(resolveDepositChain({ customer: undefined, kiosk: undefined, ready, fallback: "hedera-testnet" }), "hedera-testnet");
});
