import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
after(() => pool.end());

const row = {
  privyUserId: "did:privy:test1",
  email: "a@example.com",
  privyWallet: "0xAbCdEf0000000000000000000000000000000001",
  boundAddress: "0x0000000000000000000000000000000000000abc",
  ensName: "a-1234.wantest.eth",
};

test("insert then find by id and by wallet (case-insensitive)", async () => {
  const created = await accounts.insertAccount(row);
  assert.equal(created.privyWallet, row.privyWallet.toLowerCase());
  assert.equal(created.qrEmailedAt, null);
  assert.equal((await accounts.findByPrivyUserId(row.privyUserId))?.email, row.email);
  assert.equal((await accounts.findByWallet(row.privyWallet.toUpperCase().replace("0X", "0x")))?.privyUserId, row.privyUserId);
  assert.equal(await accounts.findByWallet("0x0000000000000000000000000000000000000fff"), null);
});

test("markQrEmailed sets the timestamp", async () => {
  await accounts.markQrEmailed(row.privyUserId);
  assert.ok((await accounts.findByPrivyUserId(row.privyUserId))?.qrEmailedAt instanceof Date);
});

test("queued deposit lifecycle", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: row.privyUserId, currency: "MYR", amount: 10 });
  assert.equal(d.status, "queued");
  assert.equal(d.txHash, null);
  await accounts.markDepositSending(d.id, "0xabc", 2.44881);
  let got = await accounts.getDeposit(d.id);
  assert.deepEqual([got?.status, got?.txHash, got?.usdAmount, got?.attempts], ["sending", "0xabc", 2.44881, 1]);
  await accounts.markDepositFailed(d.id, "rpc timeout", false);
  got = await accounts.getDeposit(d.id);
  assert.deepEqual([got?.status, got?.error], ["sending", "rpc timeout"]);
  await accounts.markDepositConfirmed(d.id);
  got = await accounts.getDeposit(d.id);
  assert.deepEqual([got?.status, got?.error], ["confirmed", null]);
  assert.equal((await accounts.listDeposits(row.privyUserId, 10)).length, 1);
});
