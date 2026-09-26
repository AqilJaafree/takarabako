import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const history = await import("../src/history.js");
after(() => pool.end());

const USER = "did:privy:h1";
await accounts.insertAccount({
  privyUserId: USER,
  email: "h@example.com",
  privyWallet: "0x0000000000000000000000000000000000000031",
  boundAddress: "0x0000000000000000000000000000000000000032",
  ensName: "h.wantest.eth",
});

test("a session collects its notes and the receipt adds them up", async () => {
  const s = await history.openDepositSession(USER);
  assert.equal((await history.currentOpenSession(USER))?.id, s.id);

  const a = await accounts.createQueuedDeposit({ privyUserId: USER, currency: "MYR", amount: 10, sessionId: s.id });
  const b = await accounts.createQueuedDeposit({ privyUserId: USER, currency: "MYR", amount: 1, sessionId: s.id });
  await accounts.markDepositSending(a.id, "0xa", 2.5);
  await accounts.markDepositConfirmed(a.id);
  await accounts.markDepositSending(b.id, "0xb", 0.25);

  await history.finishDepositSession(s.id);
  const r = await history.getReceipt(s.id);
  assert.equal(r?.status, "finished");
  assert.equal(r?.notes.length, 2);
  assert.equal(r?.totalAmount, 11);
  assert.equal(r?.totalUsdConfirmed, 2.5);
  assert.equal(r?.settled, false); // b is still sending
  assert.equal(await history.currentOpenSession(USER), null);

  await accounts.markDepositConfirmed(b.id);
  const settled = await history.getReceipt(s.id);
  assert.equal(settled?.settled, true);
  assert.equal(settled?.totalUsdConfirmed, 2.75);
});

test("opening a new session closes the previous open one", async () => {
  const first = await history.openDepositSession(USER);
  const second = await history.openDepositSession(USER);
  assert.equal((await history.getReceipt(first.id))?.status, "finished");
  assert.equal((await history.currentOpenSession(USER))?.id, second.id);
});

test("markReceiptEmailed only succeeds once", async () => {
  const s = await history.openDepositSession(USER);
  await history.finishDepositSession(s.id);
  assert.equal(await history.markReceiptEmailed(s.id), true);
  assert.equal(await history.markReceiptEmailed(s.id), false);
});

test("history lists every kind newest first, and filters", async () => {
  await history.recordWithdrawal({ privyUserId: USER, destination: "wallet", grossUsd: 5, feeBps: 0, netUsd: 5, txHash: "0xw" });
  await history.recordYieldEvent({
    privyUserId: USER, action: "open", riskTier: "low", pair: "USDC/ETH", apyBps: 320,
    amountUsd: 5, rationale: "steady", ensName: "uniswap-1.wantest.eth", txHash: "0xy",
  });
  await history.recordRefused({ privyUserId: USER, sessionId: null, reason: "bad_condition" });

  const all = await history.listHistory(USER, { limit: 50 });
  const kinds = all.map((h) => h.kind);
  assert.deepEqual(kinds.slice(0, 3), ["refused", "yield", "withdrawal"]);
  assert.ok(kinds.includes("deposit_session"));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at >= all[i].at, "newest first");

  const onlyWithdrawals = await history.listHistory(USER, { limit: 50, kind: "withdrawal" });
  assert.deepEqual(onlyWithdrawals.map((h) => h.kind), ["withdrawal"]);

  const sessions = await history.listHistory(USER, { limit: 50, kind: "deposit_session" });
  const withNotes = sessions.find((h) => h.kind === "deposit_session" && h.notes.length === 2);
  assert.ok(withNotes, "deposit sessions carry their notes");
});
