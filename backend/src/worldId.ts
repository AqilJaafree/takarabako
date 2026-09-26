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
/// A verified human unlocks what needs a real person behind it: holding and
/// moving tkCASH (its on-chain allowlist), sending by name, and the treasury's
/// gas for their wallet. Their ENS name gets `takarabako.verified = world-id`.

export const worldIdReady = Boolean(config.worldId.appId && config.worldId.rpId && config.worldId.signingKey && config.worldId.action);

const VERIFY_URL = (rpId: string) => `https://developer.worldcoin.org/api/v4/verify/${rpId}`;
const NEW_HUMAN_GAS_ETH = 0.001;

/// What the browser needs to open the World ID widget for this customer.
export function requestContext(account: Account) {
  const sig = signRequest({ signingKeyHex: config.worldId.signingKey, action: config.worldId.action });
  return {
    app_id: config.worldId.appId,
    action: config.worldId.action,
    environment: config.worldId.environment,
    preset: config.worldId.preset,
    signal: account.privyWallet,
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

export type VerifyOutcome =
  | { ok: true; credential: string; alreadyVerified: boolean }
  | { ok: false; status: number; error: string };

export async function verifyHuman(account: Account, result: IdkitResult): Promise<VerifyOutcome> {
  if (!worldIdReady) return { ok: false, status: 503, error: "World ID is not configured" };
  const response = result.responses?.[0];
  if (!response?.nullifier) return { ok: false, status: 400, error: "no World ID proof in the request" };
  if (result.action && result.action !== config.worldId.action) return { ok: false, status: 400, error: "proof is for a different action" };

  // The proof must be bound to this customer's wallet (the signal we asked for).
  const expected = String(hashSignal(account.privyWallet)).toLowerCase();
  if (response.signal_hash && response.signal_hash.toLowerCase() !== expected) {
    return { ok: false, status: 400, error: "proof was made for a different account" };
  }

  const res = await fetch(VERIFY_URL(config.worldId.rpId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; detail?: string; code?: string; message?: string };
  if (!res.ok || body.success === false) {
    return { ok: false, status: 400, error: `World ID rejected the proof${body.detail || body.code || body.message ? `: ${body.detail ?? body.code ?? body.message}` : ""}` };
  }

  const nullifier = response.nullifier.toLowerCase();
  const { rows: others } = await pool.query(
    "select ens_name from accounts where world_nullifier = $1 and privy_user_id <> $2",
    [nullifier, account.privyUserId],
  );
  if (others.length) return { ok: false, status: 409, error: "this World ID has already verified another Takarabako account" };

  const alreadyVerified = Boolean(account.worldVerifiedAt);
  await pool.query(
    "update accounts set world_nullifier = $2, world_credential = $3, world_verified_at = coalesce(world_verified_at, now()) where privy_user_id = $1",
    [account.privyUserId, nullifier, response.identifier ?? null],
  );
  if (!alreadyVerified) {
    void unlockVerified(account, response.identifier ?? "world-id").catch((err) =>
      console.error("[world-id] unlock failed:", err instanceof Error ? err.message : err),
    );
  }
  return { ok: true, credential: response.identifier ?? "world-id", alreadyVerified };
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
