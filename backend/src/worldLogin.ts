import { randomBytes } from "node:crypto";
import { redis } from "./redis.js";
import { findByWorldNullifier } from "./accounts.js";
import { depositLogin } from "./depositLogin.js";
import { checkProof, requestContext, worldIdReady, type IdkitResult } from "./worldId.js";

/// World ID login at the deposit terminal. We don't know who's there yet, so
/// the proof is bound to a one-time nonce instead of a wallet; the proof's
/// nullifier (World ID's anonymous per-app id for the person) then finds the
/// account that verified with it. Same action as verification, so the
/// nullifier matches the one recorded then.

const NONCE_TTL_S = 300;
const nonceKey = (nonce: string) => `worldlogin:${nonce}`;

export async function worldLoginRequest() {
  const nonce = randomBytes(32).toString("hex");
  await redis.set(nonceKey(nonce), "1", "EX", NONCE_TTL_S);
  return { nonce, ...requestContext(nonce) };
}

export type WorldLoginOutcome =
  | { ok: true; login: Awaited<ReturnType<typeof depositLogin>> }
  | { ok: false; status: number; error: string };

export async function loginWithWorld(nonce: string, result: IdkitResult): Promise<WorldLoginOutcome> {
  if (!worldIdReady) return { ok: false, status: 503, error: "World ID is not configured" };
  // Spend the nonce first: each request logs in at most once, even if two race.
  if (!/^[0-9a-f]{64}$/.test(nonce) || (await redis.del(nonceKey(nonce))) !== 1) {
    return { ok: false, status: 400, error: "This World ID request expired — try again" };
  }
  const proof = await checkProof(result, nonce, { requireSignalHash: true, mismatch: "proof was made for a different request" });
  if (!proof.ok) return proof;

  const account = await findByWorldNullifier(proof.nullifier);
  if (!account) {
    return { ok: false, status: 404, error: "This World ID isn't linked to a Takarabako account yet — scan your QR instead." };
  }
  return { ok: true, login: await depositLogin(account) };
}
