import { test, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { freshDb } from "./helpers.js";

process.env.WORLD_APP_ID = "app_test";
process.env.WORLD_RP_ID = "rp_test";
process.env.WORLD_APP_SIGNING_KEY = `0x${"11".repeat(32)}`;
process.env.WORLD_ACTION = "selfie";
process.env.WORLD_ENVIRONMENT = "production"; // don't let a sandbox/staging shell env leak in
delete process.env.WORLD_ENVIROMENT;
delete process.env.MULTIBAAS_URL; // no chain side effects in tests
delete process.env.ENS_REGISTRY_ADDRESS;

const pool = await freshDb();
const { redis } = await import("../src/redis.js");
const { worldLoginRequest, loginWithWorld } = await import("../src/worldLogin.js");
const accounts = await import("../src/accounts.js");
after(async () => {
  await pool.end();
  redis.disconnect();
});

const ALICE = { privyUserId: "u-alice", email: "a@x.io", privyWallet: "0x00000000000000000000000000000000000000a1", boundAddress: "0x00000000000000000000000000000000000000b1", ensName: "alice.takarabako.eth" };
await accounts.insertAccount(ALICE);
await pool.query("update accounts set world_nullifier = '0xabc123', world_verified_at = now() where privy_user_id = 'u-alice'");

const proof = (signal: string | null, nullifier = "0xABC123") => ({
  protocol_version: "3.0",
  action: "selfie",
  environment: "production",
  responses: [{ identifier: "device", nullifier, ...(signal === null ? {} : { signal_hash: String(hashSignal(signal)) }), proof: "0x1", merkle_root: "0x2" }],
});

let worldCalls = 0;
beforeEach(() => {
  worldCalls = 0;
  mock.method(globalThis, "fetch", async () => {
    worldCalls++;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});

test("a login request is signed and bound to a one-time nonce", async () => {
  const r = await worldLoginRequest();
  assert.match(r.nonce, /^[0-9a-f]{64}$/);
  assert.equal(r.signal, r.nonce);
  assert.equal(r.action, "selfie");
  const ttl = await redis.ttl(`worldlogin:${r.nonce}`);
  assert.ok(ttl > 0 && ttl <= 300);
});

test("a verified human gets a deposit-only session", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof(nonce));
  assert.equal(r.ok, true);
  const login = (r as { login: { scope: string; ensName: string; token: string; worldVerified: boolean } }).login;
  assert.equal(login.scope, "deposit");
  assert.equal(login.ensName, ALICE.ensName);
  assert.equal(login.worldVerified, true);
  assert.match(login.token, /^[0-9a-f]{64}$/);
});

test("a nonce works once", async () => {
  const { nonce } = await worldLoginRequest();
  assert.equal((await loginWithWorld(nonce, proof(nonce))).ok, true);
  const again = await loginWithWorld(nonce, proof(nonce));
  assert.deepEqual(again, { ok: false, status: 400, error: "This World ID request expired — try again" });
  assert.equal(worldCalls, 1); // only the first attempt reached World
});

test("an unknown nonce is refused without asking World", async () => {
  const r = await loginWithWorld("f".repeat(64), proof("f".repeat(64)));
  assert.equal(r.ok, false);
  assert.equal(worldCalls, 0);
});

test("a proof without a signal hash is refused", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof(null));
  assert.deepEqual(r, { ok: false, status: 400, error: "proof was made for a different request" });
  assert.equal(worldCalls, 0);
});

test("a proof made for another nonce is refused", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof("someone-elses-nonce"));
  assert.deepEqual(r, { ok: false, status: 400, error: "proof was made for a different request" });
  assert.equal(worldCalls, 0);
});

test("a sandbox proof is refused in production", async () => {
  const { config } = await import("../src/config.js");
  assert.equal(config.worldId.environment, "production"); // sanity: this file's shell env didn't leak in
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, { ...proof(nonce), environment: "sandbox" });
  assert.deepEqual(r, { ok: false, status: 400, error: "proof is for a different World ID environment" });
  assert.equal(worldCalls, 0);
});

test("a World ID that hasn't verified an account gets sent to the QR", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof(nonce, "0xnotlinked"));
  assert.deepEqual(r, { ok: false, status: 404, error: "This World ID isn't linked to a Takarabako account yet — scan your QR instead." });
});
