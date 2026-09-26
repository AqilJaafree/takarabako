import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
await pool.query("truncate ops_proposals");
const { checkMandate, mandateUsage } = await import("../src/mandate.js");
const { createProposal } = await import("../src/proposals.js");
after(() => pool.end());

test("the mandate: pause always, amounts within the daily limit, APY never", () => {
  assert.deepEqual(checkMandate("pause_kiosk", { kioskId: "tokyo-01", reason: "x" }, {}, true), { autonomous: true });
  assert.deepEqual(checkMandate("fund_yield_reserve", { amount: 60 }, { fund_yield_reserve: 30 }, true), { autonomous: true });
  const over = checkMandate("fund_yield_reserve", { amount: 80 }, { fund_yield_reserve: 30 }, true);
  assert.equal(over.autonomous, false);
  assert.match((over as { reason: string }).reason, /100 USDC a day/);
  assert.equal(checkMandate("set_apy", { bps: 500 }, {}, true).autonomous, false);
  assert.equal(checkMandate("pause_kiosk", { kioskId: "tokyo-01", reason: "x" }, {}, false).autonomous, false);
});

test("inside the mandate it executes on its own; outside, it waits for a human", async () => {
  const sent: string[] = [];
  const execute = async (action: string) => {
    sent.push(action);
    return "0xfeed";
  };
  const small = await createProposal({ action: "fund_yield_reserve", args: { amount: 40 }, rationale: "thin reserve", source: "monitor", execute });
  assert.equal(small.ok, true);
  const p = (small as { proposal: { status: string; autonomous: boolean; txHash: string } }).proposal;
  assert.equal(p.status, "executed");
  assert.equal(p.autonomous, true);
  assert.equal(p.txHash, "0xfeed");
  assert.deepEqual(await mandateUsage(), { fund_yield_reserve: 40 });

  const big = await createProposal({ action: "fund_yield_reserve", args: { amount: 90 }, rationale: "more", source: "monitor", execute });
  const q = (big as { proposal: { status: string; autonomous: boolean }; mandate?: string });
  assert.equal(q.proposal.status, "pending");
  assert.equal(q.proposal.autonomous, false);
  assert.match(q.mandate ?? "", /own limit/);

  const apy = await createProposal({ action: "set_apy", args: { bps: 500 }, rationale: "r", source: "ask", execute });
  assert.equal((apy as { proposal: { status: string } }).proposal.status, "pending");
  assert.deepEqual(sent, ["fund_yield_reserve"]);
});
