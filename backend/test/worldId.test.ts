import { test, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { freshDb } from "./helpers.js";

process.env.WORLD_APP_ID = "app_test";
process.env.WORLD_RP_ID = "rp_test";
process.env.WORLD_APP_SIGNING_KEY = `0x${"11".repeat(32)}`;
process.env.WORLD_ACTION = "eth-tokyo";
process.env.WORLD_ENVIRONMENT = "production";
delete process.env.WORLD_ENVIROMENT;
delete process.env.MULTIBAAS_URL; // no chain side effects in tests
delete process.env.ENS_REGISTRY_ADDRESS;

const pool = await freshDb();
const { verifyHuman, requestContext } = await import("../src/worldId.js");
const accounts = await import("../src/accounts.js");
after(() => pool.end());

const ALICE = { privyUserId: "u-alice", email: "a@x.io", privyWallet: "0x00000000000000000000000000000000000000a1", boundAddress: "0x00000000000000000000000000000000000000b1", ensName: "alice.takarabako.eth" };
const BOB = { privyUserId: "u-bob", email: "b@x.io", privyWallet: "0x00000000000000000000000000000000000000a2", boundAddress: "0x00000000000000000000000000000000000000b2", ensName: "bob.takarabako.eth" };
await accounts.insertAccount(ALICE);
await accounts.insertAccount(BOB);

const proof = (wallet: string, nullifier = "0xabc123") => ({
  protocol_version: "4.0",
  action: "eth-tokyo",
  nonce: "0x01",
  environment: "production",
  responses: [{ identifier: "proof_of_human", nullifier, signal_hash: String(hashSignal(wallet)), proof: ["0x1", "0x2", "0x3", "0x4", "0x5"] }],
});

let portal: { ok: boolean; body: unknown } = { ok: true, body: { success: true } };
beforeEach(() => {
  portal = { ok: true, body: { success: true } };
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(portal.body), { status: portal.ok ? 200 : 400 }));
});

const fresh = async (id: string) => (await accounts.findByPrivyUserId(id))!;

test("the widget gets an RP-signed request bound to the customer's wallet", async () => {
  const ctx = requestContext((await fresh("u-alice")).privyWallet);
  assert.equal(ctx.app_id, "app_test");
  assert.equal(ctx.action, "eth-tokyo");
  assert.equal(ctx.signal, ALICE.privyWallet);
  assert.equal(ctx.rp_context.rp_id, "rp_test");
  assert.match(ctx.rp_context.signature, /^0x[0-9a-f]+$/);
  assert.ok(ctx.rp_context.expires_at > ctx.rp_context.created_at);
});

test("a valid proof verifies the account and records the human", async () => {
  const r = await verifyHuman(await fresh("u-alice"), proof(ALICE.privyWallet));
  assert.deepEqual(r, { ok: true, credential: "proof_of_human", alreadyVerified: false });
  const a = await fresh("u-alice");
  assert.ok(a.worldVerifiedAt);
  assert.equal(a.worldCredential, "proof_of_human");
});

test("a proof made for another wallet is rejected before asking World", async () => {
  const r = await verifyHuman(await fresh("u-bob"), proof(ALICE.privyWallet, "0xdef456"));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /different account/);
});

test("World rejecting the proof is passed on", async () => {
  portal = { ok: false, body: { success: false, detail: "invalid proof" } };
  const r = await verifyHuman(await fresh("u-bob"), proof(BOB.privyWallet, "0x999"));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /invalid proof/);
});

test("the same human can't verify a second account", async () => {
  const r = await verifyHuman(await fresh("u-bob"), proof(BOB.privyWallet, "0xabc123"));
  assert.deepEqual(r, { ok: false, status: 409, error: "this World ID has already verified another Takarabako account" });
  assert.equal((await fresh("u-bob")).worldVerifiedAt, null);
});

test("re-verifying the same account is fine", async () => {
  const r = await verifyHuman(await fresh("u-alice"), proof(ALICE.privyWallet, "0xABC123"));
  assert.deepEqual(r, { ok: true, credential: "proof_of_human", alreadyVerified: true });
});

test("a sandbox proof carries the staging verification token when sandbox is configured", async () => {
  const { config } = await import("../src/config.js");
  const originalEnv = config.worldId.environment;
  config.worldId.stagingToken = "stg_test";
  config.worldId.environment = "sandbox";
  let headers: Record<string, string> = {};
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  await pool.query("update accounts set world_nullifier = null, world_verified_at = null where privy_user_id = 'u-bob'");
  await verifyHuman(await fresh("u-bob"), { ...proof(BOB.privyWallet, "0xsandbox"), environment: "sandbox" });
  assert.equal(headers["x-staging-verification-token"], "stg_test");
  config.worldId.stagingToken = "";
  config.worldId.environment = originalEnv;
});

test("a production proof carries no staging token when production is configured", async () => {
  const { config } = await import("../src/config.js");
  const originalEnv = config.worldId.environment;
  config.worldId.stagingToken = "stg_test";
  config.worldId.environment = "production";
  let headers: Record<string, string> = {};
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  // u-bob is verified with "0xsandbox" from the previous test; re-verifying is fine.
  await verifyHuman(await fresh("u-bob"), { ...proof(BOB.privyWallet, "0xsandbox"), environment: "production" });
  assert.equal(headers["x-staging-verification-token"], undefined);
  config.worldId.stagingToken = "";
  config.worldId.environment = originalEnv;
});

test("a proof for the wrong World ID environment is rejected before asking World", async () => {
  const { config } = await import("../src/config.js");
  assert.equal(config.worldId.environment, "production"); // sanity: the prior tests restored it
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  // u-bob is still verified with "0xsandbox" from earlier tests; the environment
  // mismatch is caught before checkProof even looks at the nullifier.
  const r = await verifyHuman(await fresh("u-bob"), { ...proof(BOB.privyWallet, "0xsandbox"), environment: "sandbox" });
  assert.deepEqual(r, { ok: false, status: 400, error: "proof is for a different World ID environment" });
  assert.equal(calls, 0);
});

test("with the selfie preset, only a 3.0 Selfie Check proof is accepted", async () => {
  const { config } = await import("../src/config.js");
  const preset = config.worldId.preset;
  config.worldId.preset = "selfie";
  await pool.query("update accounts set world_nullifier = null, world_verified_at = null where privy_user_id = 'u-bob'");
  const v3 = (identifier: string) => ({
    ...proof(BOB.privyWallet, "0xselfie"),
    protocol_version: "3.0",
    responses: [{ identifier, nullifier: "0xselfie", signal_hash: String(hashSignal(BOB.privyWallet)), proof: "0x1", merkle_root: "0x2" }],
  });
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });

  const weaker = await verifyHuman(await fresh("u-bob"), v3("orb"));
  assert.deepEqual(weaker, { ok: false, status: 400, error: "World ID Selfie Check required (got orb)" });
  const v4 = await verifyHuman(await fresh("u-bob"), proof(BOB.privyWallet, "0xselfie"));
  assert.deepEqual(v4, { ok: false, status: 400, error: "World ID Selfie Check required (got proof_of_human)" });
  assert.equal(calls, 0);

  assert.equal((await verifyHuman(await fresh("u-bob"), v3("selfie"))).ok, true);
  assert.equal((await verifyHuman(await fresh("u-bob"), v3("face"))).ok, true); // World's older name for it
  config.worldId.preset = preset;
});

test("a selfie result that World failed is refused even when the top-level success is true", async () => {
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ success: true, results: [{ identifier: "selfie", success: false, code: "invalid_proof" }] }), { status: 200 }),
  );
  const r = await verifyHuman(await fresh("u-bob"), proof(BOB.privyWallet, "0xselfie"));
  assert.deepEqual(r, { ok: false, status: 400, error: "World ID rejected the proof: invalid_proof" });
});
