import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const { insertAccount } = await import("../src/accounts.js");
const sessions = await import("../src/sessions.js");
after(() => pool.end());

await insertAccount({
  privyUserId: "did:privy:s1", email: "s@example.com",
  privyWallet: "0x0000000000000000000000000000000000000001",
  boundAddress: "0x0000000000000000000000000000000000000002", ensName: null,
});

test("scopeAllows", () => {
  assert.equal(sessions.scopeAllows("full", ["full"]), true);
  assert.equal(sessions.scopeAllows("full", ["deposit"]), true);
  assert.equal(sessions.scopeAllows("deposit", ["full", "deposit"]), true);
  assert.equal(sessions.scopeAllows("deposit", ["full"]), false);
});

test("create, touch extends, end revokes", async () => {
  const { token, expiresAt } = await sessions.createSession("did:privy:s1", "deposit");
  assert.match(token, /^[0-9a-f]{64}$/);
  const touched = await sessions.touchSession(token);
  assert.equal(touched?.scope, "deposit");
  assert.ok(touched!.expiresAt.getTime() >= expiresAt.getTime());
  await sessions.endSession(token);
  assert.equal(await sessions.touchSession(token), null);
});

test("expired session is rejected", async () => {
  const { token } = await sessions.createSession("did:privy:s1", "full");
  await pool.query("update sessions set expires_at = now() - interval '1 second' where token = $1", [token]);
  assert.equal(await sessions.touchSession(token), null);
});

test("unknown token is rejected", async () => {
  assert.equal(await sessions.touchSession("nope"), null);
});
