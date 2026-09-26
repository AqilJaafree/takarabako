import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { Address } from "viem";
import { config } from "./config.js";
import { pool } from "./db.js";
import type { Account } from "./accounts.js";
import { allowlist } from "./cashReceipt.js";
import { setRecords } from "./ens.js";
import { chainReady, fundWalletWithEthOnChain, publicClient } from "./chain.js";

/// World ID (IDKit 4): proof that an account belongs to a unique human.
/// The backend signs each verification request with the RP signing key
/// (never sent to the browser), binds it to the customer's own wallet as the
/// signal so a proof can't be replayed for another account, and forwards the
/// proof to the Developer Portal. The proof's nullifier is World ID's
/// anonymous per-app identifier for that person; a unique index on it means
/// one human, one account.
///
/// Customers verify right after creating their wallet (a World ID selfie in
/// the web app). Until they do, limits.ts caps what they can move in a day;
/// verifying lifts the cap and their ENS name gets `takarabako.verified = world-id`.

export const worldIdReady = Boolean(config.worldId.appId && config.worldId.rpId && config.worldId.signingKey && config.worldId.action);

if (worldIdReady && config.worldId.environment !== "production" && (!config.worldId.stagingToken || config.worldId.stagingToken === "stg_test")) {
  console.warn(
    `[world-id] environment is ${config.worldId.environment} but WORLD_STAGING_VERIFICATION_TOKEN isn't a real token — ` +
      "sandbox proofs will be refused. Run `npm run world:staging` to open a 24h window.",
  );
}

/// What a proof must be for each WORLD_PRESET. Selfie Check proofs say "selfie"
/// (World's older name, "face", is still sent by some World App builds).
/// `device` takes any credential: it's the lowest level anyway.
const CREDENTIAL: Record<string, { protocol: string; identifiers: string[] } | undefined> = {
  selfie: { protocol: "3.0", identifiers: ["selfie", "face"] },
  "selfie-v4": { protocol: "4.0", identifiers: ["selfie"] },
};

const VERIFY_URL =(rpId: string) => `https://developer.world.org/api/v4/verify/${rpId}`;
const NEW_HUMAN_GAS_ETH = 0.001;

/// What the browser needs to open the World ID widget. The signal binds the
/// proof: the customer's wallet for verification, a one-time nonce for login.
export function requestContext(signal: string) {
  const sig = signRequest({ signingKeyHex: config.worldId.signingKey, action: config.worldId.action });
  return {
    app_id: config.worldId.appId,
    action: config.worldId.action,
    environment: config.worldId.environment,
    preset: config.worldId.preset,
    signal,
    rp_context: {
      rp_id: config.worldId.rpId,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
    },
  };
}

interface ProofResponse {
  identifier: string;
  nullifier: string;
  signal_hash?: string;
}

export interface IdkitResult {
  protocol_version: string;
  action?: string;
  environment?: string;
  responses: ProofResponse[];
  [k: string]: unknown;
}

export type ProofCheck =
  | { ok: true; nullifier: string; credential: string }
  | { ok: false; status: number; error: string };

export type VerifyOutcome =
  | { ok: true; credential: string; alreadyVerified: boolean }
  | { ok: false; status: number; error: string };

/// Checks a proof is for our action and signal, then asks World whether it's
/// valid. requireSignalHash: refuse proofs that don't carry a signal hash
/// (login needs the proof bound to its nonce).
export async function checkProof(
  result: IdkitResult,
  signal: string,
  opts: { requireSignalHash?: boolean; mismatch?: string } = {},
): Promise<ProofCheck> {
  if (!worldIdReady) return { ok: false, status: 503, error: "World ID is not configured" };
  const response = result?.responses?.[0];
  if (!response?.nullifier) return { ok: false, status: 400, error: "no World ID proof in the request" };
  if (result.action && result.action !== config.worldId.action) return { ok: false, status: 400, error: "proof is for a different action" };

  // The environment comes from the client: only accept the one we're configured for,
  // so sandbox (simulator) proofs can't pass as real humans in production.
  const wantProd = config.worldId.environment === "production";
  const gotProd = (result.environment ?? "production") === "production";
  if (wantProd !== gotProd) return { ok: false, status: 400, error: "proof is for a different World ID environment" };

  // The preset (which credential to prove) isn't covered by the RP signature,
  // so a client could answer with a weaker credential than we asked for.
  const want = CREDENTIAL[config.worldId.preset];
  if (want && (result.protocol_version !== want.protocol || !want.identifiers.includes(response.identifier))) {
    return { ok: false, status: 400, error: `World ID Selfie Check required (got ${response.identifier ?? "unknown"})` };
  }

  const expected = String(hashSignal(signal)).toLowerCase();
  const got = response.signal_hash?.toLowerCase();
  if (got ? got !== expected : opts.requireSignalHash) {
    return { ok: false, status: 400, error: opts.mismatch ?? "proof was made for a different account" };
  }

  const res = await fetch(VERIFY_URL(config.worldId.rpId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(!wantProd && config.worldId.stagingToken ? { "x-staging-verification-token": config.worldId.stagingToken } : {}),
    },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    detail?: string;
    code?: string;
    message?: string;
    results?: { identifier: string; success: boolean; code?: string; detail?: string }[];
  };
  // World answers per credential in results[]; a failed entry can sit under a
  // top-level success, so every entry has to pass.
  const failed = body.results?.find((r) => r.success !== true);
  if (!res.ok || body.success === false || failed) {
    const why = failed?.detail ?? failed?.code ?? body.detail ?? body.code ?? body.message;
    return { ok: false, status: 400, error: `World ID rejected the proof${why ? `: ${why}` : ""}` };
  }
  return { ok: true, nullifier: response.nullifier.toLowerCase(), credential: response.identifier ?? "world-id" };
}

export async function verifyHuman(account: Account, result: IdkitResult): Promise<VerifyOutcome> {
  // The proof must be bound to this customer's wallet (the signal we asked for).
  const proof = await checkProof(result, account.privyWallet);
  if (!proof.ok) return proof;
  const { nullifier, credential } = proof;

  const { rows: others } = await pool.query(
    "select ens_name from accounts where world_nullifier = $1 and privy_user_id <> $2",
    [nullifier, account.privyUserId],
  );
  if (others.length) return { ok: false, status: 409, error: "this World ID has already verified another Takarabako account" };

  const alreadyVerified = Boolean(account.worldVerifiedAt);
  await pool.query(
    "update accounts set world_nullifier = $2, world_credential = $3, world_verified_at = coalesce(world_verified_at, now()) where privy_user_id = $1",
    [account.privyUserId, nullifier, credential],
  );
  if (!alreadyVerified) {
    void unlockVerified(account, credential).catch((err) =>
      console.error("[world-id] unlock failed:", err instanceof Error ? err.message : err),
    );
  }
  return { ok: true, credential, alreadyVerified };
}

/// What a verified human gets. Background: the response doesn't wait on chain calls.
async function unlockVerified(account: Account, credential: string) {
  const log = (what: string) => (err: unknown) => console.error(`[world-id] ${what} for ${account.ensName}:`, err instanceof Error ? err.message : err);
  await allowlist(account.privyWallet).catch(log("tkCASH allowlist"));
  if (account.ensName) {
    await setRecords(account.ensName, { texts: { "takarabako.verified": "world-id", "takarabako.worldCredential": credential } }).catch(log("ENS record"));
  }
  if (chainReady) {
    const eth = Number(await publicClient.getBalance({ address: account.privyWallet as Address })) / 1e18;
    if (eth < NEW_HUMAN_GAS_ETH / 2) await fundWalletWithEthOnChain(account.privyWallet as Address, NEW_HUMAN_GAS_ETH).catch(log("gas"));
  }
  console.log(`[world-id] ${account.ensName} verified as a unique human (${credential})`);
}

export const isVerifiedHuman = (account: Account) => !worldIdReady || Boolean(account.worldVerifiedAt);
