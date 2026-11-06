import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const { checkMachine, sessionHash, DOMAIN, TYPES } = await import("../src/machine.js");
const { registerKiosk, setKioskActive } = await import("../src/kiosks.js");
after(() => pool.end());

const KIOSK = "mumbai-01";
const device = privateKeyToAccount(generatePrivateKey());
const token = "session-token-abc";
await registerKiosk({ id: KIOSK, signer: device.address, chain: "arc-testnet" });

async function sign(over: Partial<{ amount: string; currency: string; token: string; nonce: bigint; issuedAt: bigint; kiosk: string }> = {}, signer = device) {
  const message = {
    kiosk: over.kiosk ?? KIOSK,
    amount: over.amount ?? "10",
    currency: over.currency ?? "MYR",
    session: sessionHash(over.token ?? token),
    nonce: over.nonce ?? 1n,
    issuedAt: over.issuedAt ?? BigInt(Math.floor(Date.now() / 1000)),
  };
  const signature = await signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "NoteAccepted", message });
  return { kiosk: message.kiosk, amount: message.amount, currency: message.currency, nonce: message.nonce.toString(), issuedAt: message.issuedAt.toString(), signature };
}

const deposit = { amount: 10, currency: "MYR", token };

test("a note signed by the kiosk's registered device key verifies, and reports the kiosk's chain", async () => {
  const r = await checkMachine(await sign(), deposit);
  assert.equal(r.verified, true);
  if (r.verified) {
    assert.equal(r.signer, device.address);
    assert.equal(r.chain, "arc-testnet");
  }
});

test("unsigned deposits are reported as unsigned", async () => {
  assert.deepEqual(await checkMachine(undefined, deposit), { verified: false, reason: "unsigned" });
});

test("a different device can't sign for the kiosk", async () => {
  const other = privateKeyToAccount(generatePrivateKey());
  const r = await checkMachine(await sign({}, other), deposit);
  assert.equal(r.verified, false);
  assert.match((r as { reason: string }).reason, /different device/);
});

test("the signed amount must be the deposited amount", async () => {
  const r = await checkMachine(await sign({ amount: "100" }), deposit);
  assert.equal(r.verified, false);
});

test("a signature from another customer's session doesn't verify here", async () => {
  const r = await checkMachine(await sign({ token: "someone-else" }), deposit);
  assert.equal(r.verified, false);
});

test("old signatures and unregistered kiosks are rejected", async () => {
  const old = await checkMachine(await sign({ issuedAt: BigInt(Math.floor(Date.now() / 1000) - 3600) }), deposit);
  assert.match((old as { reason: string }).reason, /too old/);
  const unknown = await checkMachine(await sign({ kiosk: "fake-box" }), deposit);
  assert.match((unknown as { reason: string }).reason, /isn't registered/);
});

test("a switched-off kiosk is rejected, and works again when switched on", async () => {
  await setKioskActive(KIOSK, false);
  assert.match(((await checkMachine(await sign({ nonce: 3n }), deposit)) as { reason: string }).reason, /switched off/);
  await setKioskActive(KIOSK, true);
  assert.equal((await checkMachine(await sign({ nonce: 3n }), deposit)).verified, true);
});

test("registering a kiosk again rotates its key", async () => {
  const next = privateKeyToAccount(generatePrivateKey());
  await registerKiosk({ id: KIOSK, signer: next.address, chain: "sepolia" });
  assert.match(((await checkMachine(await sign({ nonce: 4n }), deposit)) as { reason: string }).reason, /different device/);
  assert.equal((await checkMachine(await sign({ nonce: 4n }, next), deposit)).verified, true);
});

test("a device nonce can't be replayed", async () => {
  await pool.query("insert into accounts (privy_user_id, email, privy_wallet, bound_address, label) values ('u-m', 'm-test', '0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', 'm')");
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, status, machine_name, machine_nonce, machine_verified) values ($1, 'u-m', 'MYR', 10, 'confirmed', $2, 7, true)", [crypto.randomUUID(), KIOSK]);
  const next = privateKeyToAccount(generatePrivateKey());
  await registerKiosk({ id: KIOSK, signer: next.address });
  const r = await checkMachine(await sign({ nonce: 7n }, next), deposit);
  assert.match((r as { reason: string }).reason, /replayed/);
});
