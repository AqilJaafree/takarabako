import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

delete process.env.MULTIBAAS_URL; // no chain side effects in tests

const pool = await freshDb();
const { redis } = await import("../src/redis.js");
const codes = await import("../src/depositCode.js");
const accounts = await import("../src/accounts.js");
after(async () => {
  await pool.end();
  redis.disconnect();
});

await accounts.insertAccount({
  privyUserId: "u-dq", email: "dq@x.io",
  privyWallet: "0x00000000000000000000000000000000000000d1",
  boundAddress: "0x00000000000000000000000000000000000000d2", ensName: "dq.takarabako.eth",
});

test("a deposit QR carries a random code that lives 5 minutes", async () => {
  const issued = await codes.issueDepositCode("u-dq");
  assert.match(issued.qr, /^takarabako:deposit:[A-Za-z0-9_-]{32}$/);
  assert.equal(issued.ttlSeconds, 300);
  const code = issued.qr.slice(codes.DEPOSIT_QR_PREFIX.length);
  const ttl = await redis.ttl(`depositqr:${code}`);
  assert.ok(ttl > 0 && ttl <= 300);
  assert.ok(codes.isDepositQr(issued.qr));
  assert.ok(!codes.isDepositQr("0x00000000000000000000000000000000000000d1"));
});

test("a live code finds its account, and works for more than one scan", async () => {
  const { qr } = await codes.issueDepositCode("u-dq");
  for (let i = 0; i < 2; i++) {
    const r = await codes.accountForDepositQr(qr);
    assert.equal(r.ok, true);
    assert.equal((r as { account: { privyUserId: string } }).account.privyUserId, "u-dq");
  }
});

test("issuing a new QR kills the previous one", async () => {
  const first = await codes.issueDepositCode("u-dq");
  const second = await codes.issueDepositCode("u-dq");
  assert.notEqual(first.qr, second.qr);
  const old = await codes.accountForDepositQr(first.qr);
  assert.deepEqual(old, { ok: false, status: 410, error: "This QR has expired. Open Deposit on your phone for a new one." });
  assert.equal((await codes.accountForDepositQr(second.qr)).ok, true);
});

test("expired, unknown and malformed codes read as expired", async () => {
  const { qr } = await codes.issueDepositCode("u-dq");
  await redis.del(`depositqr:${qr.slice(codes.DEPOSIT_QR_PREFIX.length)}`); // what expiry does
  for (const text of [qr, `${codes.DEPOSIT_QR_PREFIX}${"a".repeat(32)}`, `${codes.DEPOSIT_QR_PREFIX}nope`]) {
    const r = await codes.accountForDepositQr(text);
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 410);
  }
});
