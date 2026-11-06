import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

process.env.DAILY_LIMIT_USD = "1000";
delete process.env.MULTIBAAS_URL;

const mail = (name: string) => `${name}${String.fromCharCode(64)}example.com`;
const pool = await freshDb();
const { assertWithinLimit, dailyAllowance, usedToday, DailyLimitError } = await import("../src/limits.js");
const accounts = await import("../src/accounts.js");
after(() => pool.end());

const CAROL = { privyUserId: "u-carol", email: mail("carol"), privyWallet: "0x00000000000000000000000000000000000000c1", boundAddress: "0x00000000000000000000000000000000000000d1", label: "carol" };
await accounts.insertAccount(CAROL);
const carol = async () => (await accounts.findByPrivyUserId("u-carol"))!;
const id = () => crypto.randomUUID();

test("everything a customer moves today counts toward the limit", async () => {
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status) values ($1, 'u-carol', 'USD', 300, 300, 'confirmed')", [id()]);
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status, chain) values ($1, 'u-carol', 'USD', 100, 100, 'confirmed', 'arc-testnet')", [id()]);
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status) values ($1, 'u-carol', 'USD', 999, 999, 'failed')", [id()]);
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status, created_at) values ($1, 'u-carol', 'USD', 500, 500, 'confirmed', now() - interval '2 days')", [id()]);
  await pool.query("insert into withdrawals (id, privy_user_id, destination, gross_usd, fee_bps, net_usd) values ($1, 'u-carol', 'cash', 200, 200, 196)", [id()]);
  await pool.query("insert into yield_events (id, privy_user_id, action, amount_usd) values ($1, 'u-carol', 'open', 150)", [id()]);
  await pool.query("insert into yield_events (id, privy_user_id, action, amount_usd) values ($1, 'u-carol', 'close', 150)", [id()]);
  await pool.query("insert into transfers (id, kind, from_user, amount_usd) values ($1, 'balance', 'u-carol', 50)", [id()]);
  await pool.query("insert into bridge_transfers (id, privy_user_id, from_chain, to_chain, amount_usd, recipient, state) values ($1, 'u-carol', 'sepolia', 'arc-testnet', 25, '0x1', 'burned')", [id()]);
  await pool.query("insert into bridge_transfers (id, privy_user_id, from_chain, to_chain, amount_usd, recipient, state) values ($1, 'u-carol', 'sepolia', 'arc-testnet', 40, '0x1', 'failed')", [id()]);
  // failed deposits and bridges, old deposits and position closes don't count
  assert.equal(await usedToday("u-carol"), 825);
  const a = await dailyAllowance(await carol());
  assert.deepEqual(a, { limited: true, limitUsd: 1000, usedUsd: 825, leftUsd: 175 });
});

test("going over the limit is refused; up to it is fine", async () => {
  await assertWithinLimit(await carol(), 175);
  await assert.rejects(assertWithinLimit(await carol(), 175.01, "this send"), (err) => {
    assert.ok(err instanceof DailyLimitError);
    assert.equal(err.status, 403);
    assert.match(err.message, /\$175 left today/);
    return true;
  });
});

test("every account has the same limit", async () => {
  await accounts.insertAccount({ privyUserId: "u-dave", email: mail("dave"), privyWallet: "0x00000000000000000000000000000000000000c2", boundAddress: "0x00000000000000000000000000000000000000d2", label: "dave" });
  const dave = (await accounts.findByPrivyUserId("u-dave"))!;
  assert.deepEqual(await dailyAllowance(dave), { limited: true, limitUsd: 1000, usedUsd: 0, leftUsd: 1000 });
  await assert.rejects(assertWithinLimit(dave, 1000.01), DailyLimitError);
});
