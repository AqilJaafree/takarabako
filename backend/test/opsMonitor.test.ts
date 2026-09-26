import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { evaluate, resetMonitor } from "../src/opsMonitor.js";
import type { StoredEvent } from "../src/chainEvents.js";

const event = (name: string, contractLabel: string, inputs: Record<string, string>): StoredEvent => ({
  id: crypto.randomUUID(),
  name,
  contractLabel,
  contractAddress: null,
  inputs,
  txHash: "0x1",
  blockNumber: 1,
  triggeredAt: new Date(),
});

beforeEach(() => resetMonitor());

test("a non-zero attestation delta is critical and wakes the agent", () => {
  const [f] = evaluate(event("ReserveAttested", "takarabako_cash_receipt", { delta: "-5000000" }));
  assert.equal(f?.rule, "reserve_mismatch");
  assert.equal(f?.severity, "critical");
  assert.equal(f?.wakeAgent, true);
  assert.match(f?.message ?? "", /by −\$5\.00/);
  assert.deepEqual(evaluate(event("ReserveAttested", "takarabako_cash_receipt", { delta: "0" })), []);
});

test("large cash-ins are flagged", () => {
  assert.equal(evaluate(event("CashIn", "takarabako_cash_receipt", { amount: "600000000" }))[0]?.rule, "large_cash_in");
  assert.deepEqual(evaluate(event("CashIn", "takarabako_cash_receipt", { amount: "20000000" })), []);
});

test("three withdrawals within ten minutes is a burst", () => {
  const w = () => event("Withdrawn", "takarabako_vault", { usdcAmount: "1" });
  const t = 1_000_000;
  assert.deepEqual(evaluate(w(), t), []);
  assert.deepEqual(evaluate(w(), t + 60_000), []);
  assert.equal(evaluate(w(), t + 120_000)[0]?.rule, "withdrawal_burst");
  resetMonitor();
  evaluate(w(), t);
  evaluate(w(), t + 11 * 60_000);
  assert.deepEqual(evaluate(w(), t + 22 * 60_000), []);
});
