import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const { createProposal, approveProposal, rejectProposal, listProposals, policyContext } = await import("../src/proposals.js");

const pool = await freshDb();
before(() => pool.query("truncate ops_proposals, ops_alerts"));
after(() => pool.end());

test("a proposal outside policy is never filed", async () => {
  const result = await createProposal({ action: "set_apy", args: { bps: 5000 }, rationale: "customers want 50%" });
  assert.equal(result.ok, false);
  assert.equal((await listProposals()).length, 0);
});

test("approve executes once, through the executor, and records the tx", async () => {
  const created = await createProposal({ action: "fund_yield_reserve", args: { amount: 300 }, rationale: "coverage at 1.1" });
  assert.ok(created.ok);
  const id = created.proposal.id;
  assert.equal(created.proposal.status, "pending");

  const calls: unknown[] = [];
  const execute = async (action: string, args: unknown) => {
    calls.push([action, args]);
    return "0xabc";
  };
  const approved = await approveProposal(id, execute);
  assert.ok(approved.ok);
  assert.equal(approved.proposal.status, "executed");
  assert.equal(approved.proposal.txHash, "0xabc");
  assert.deepEqual(calls, [["fund_yield_reserve", { amount: 300 }]]);

  // A second click can't execute it again.
  const again = await approveProposal(id, execute);
  assert.equal(again.ok, false);
  assert.equal(calls.length, 1);

  // Today's funding now counts toward the cap.
  assert.equal((await policyContext()).fundedToday, 300);
  const tooMuch = await createProposal({ action: "fund_yield_reserve", args: { amount: 300 }, rationale: "more" });
  assert.equal(tooMuch.ok, false);
});

test("pending proposals count toward the daily cap when filing", async () => {
  await pool.query("truncate ops_proposals");
  const first = await createProposal({ action: "fund_yield_reserve", args: { amount: 500 }, rationale: "top up" });
  assert.ok(first.ok);
  const duplicate = await createProposal({ action: "fund_yield_reserve", args: { amount: 500 }, rationale: "top up again" });
  assert.equal(duplicate.ok, false);
  // Rejecting the first frees the cap again.
  await rejectProposal(first.proposal.id);
  assert.ok((await createProposal({ action: "fund_yield_reserve", args: { amount: 500 }, rationale: "retry" })).ok);
});

test("a failed execution is recorded, not retried", async () => {
  const created = await createProposal({ action: "set_apy", args: { bps: 500 }, rationale: "match market" });
  assert.ok(created.ok);
  const result = await approveProposal(created.proposal.id, async () => {
    throw new Error("MultiBaas 500: boom");
  });
  assert.ok(result.ok);
  assert.equal(result.proposal.status, "failed");
  assert.match(result.proposal.error ?? "", /boom/);
});

test("reject discards a pending proposal and can't reject twice", async () => {
  const created = await createProposal({ action: "pause_kiosk", args: { kioskId: "tokyo-01", reason: "audit" }, rationale: "r" });
  assert.ok(created.ok);
  const rejected = await rejectProposal(created.proposal.id, "not needed");
  assert.ok(rejected.ok);
  assert.equal(rejected.proposal.status, "rejected");
  assert.equal((await rejectProposal(created.proposal.id)).ok, false);
  assert.equal((await approveProposal(created.proposal.id, async () => "0x")).ok, false);
});
