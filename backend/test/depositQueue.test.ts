import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const { processDeposit } = await import("../src/depositQueue.js");
after(() => pool.end());

await accounts.insertAccount({
  privyUserId: "did:privy:q1", email: "q@example.com",
  privyWallet: "0x0000000000000000000000000000000000000011",
  boundAddress: "0x0000000000000000000000000000000000000022", ensName: null,
});

function fakeChain() {
  const calls = { sent: 0, waited: [] as string[], events: [] as string[] };
  return {
    calls,
    deps: {
      toUsd: async (amount: number) => ({ usdAmount: amount * 0.25, rate: 0.25, source: "test" }),
      send: async () => { calls.sent++; return "0xfeed" as `0x${string}`; },
      wait: async (hash: string) => { calls.waited.push(hash); return 12.5; },
      publish: async (_user: string, e: { type: string }) => { calls.events.push(e.type); },
    },
  };
}

test("fresh deposit: sends once, stores hash, confirms, publishes", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 10 });
  const { calls, deps } = fakeChain();
  await processDeposit(d.id, deps);
  assert.equal(calls.sent, 1);
  assert.deepEqual(calls.waited, ["0xfeed"]);
  assert.deepEqual(calls.events, ["deposit.confirmed"]);
  const row = await accounts.getDeposit(d.id);
  assert.deepEqual([row?.status, row?.txHash, row?.usdAmount], ["confirmed", "0xfeed", 2.5]);
});

test("retry after a crash with a stored hash never resends", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 1 });
  await accounts.markDepositSending(d.id, "0xalready", 0.25);
  const { calls, deps } = fakeChain();
  await processDeposit(d.id, deps);
  assert.equal(calls.sent, 0);
  assert.deepEqual(calls.waited, ["0xalready"]);
  assert.equal((await accounts.getDeposit(d.id))?.status, "confirmed");
});

test("already-confirmed job is a no-op", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 5 });
  await accounts.markDepositSending(d.id, "0xdone", 1.25);
  await accounts.markDepositConfirmed(d.id);
  const { calls, deps } = fakeChain();
  await processDeposit(d.id, deps);
  assert.equal(calls.sent + calls.waited.length, 0);
});

test("a failed send leaves no hash, so the retry sends again", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 20 });
  const { deps } = fakeChain();
  await assert.rejects(processDeposit(d.id, { ...deps, send: async () => { throw new Error("rpc down"); } }));
  assert.equal((await accounts.getDeposit(d.id))?.txHash, null);
  const retry = fakeChain();
  await processDeposit(d.id, retry.deps);
  assert.equal(retry.calls.sent, 1);
});
