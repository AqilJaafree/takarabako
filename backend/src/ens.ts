import { keccak256, toBytes, type Address } from "viem";
import { config } from "./config.js";
import { chainReady, registerEnsLabelOnChain } from "./chain.js";

/// PRD §7.7 — ENS v2 subname registrar under `wantest.eth`. Real, not a
/// stub: `wantest.eth` itself is registered on ENS v2's Sepolia Beta
/// deployment, and this UserRegistry is its real, deployed subregistry
/// (DEPLOYMENTS.md has every address, how each was verified, and how the
/// deployment/salt/role-bitmap values were derived).
const WANTEST_SUBREGISTRY: Address = "0x786441fDe1a4006EadD745A8b90d8621F7a99916";

// Matches wantest.eth's own registration expiry (2027-09-12) — subnames
// can't outlive their parent, so there's no reason to pick anything later;
// renewing wantest.eth for real would need bumping this too.
const SUBNAME_EXPIRY = 1820728524n;

/// ATM-style flow: identity (email) comes before any per-box "handle" now,
/// so the wallet's ENS label is derived from the email itself — the local
/// part, sanitized to valid label characters, plus a short disambiguator so
/// two different domains with the same local part (alice@gmail.com vs
/// alice@yahoo.com) don't collide into the same subname.
export function deriveEnsLabel(email: string): string {
  const [localPart] = email.toLowerCase().split("@");
  const sanitized = (localPart ?? "user").replace(/[^a-z0-9-]/g, "").slice(0, 20) || "user";
  const disambiguator = keccak256(toBytes(email)).slice(2, 6);
  return `${sanitized}-${disambiguator}`;
}

export function walletSubname(label: string): string {
  return `${label}.${config.ens.parentName}`;
}

export function positionSubname(positionId: number): string {
  return `uniswap-${positionId}.${config.ens.parentName}`;
}

export async function registerSubname(subname: string, owner: string): Promise<{ txHash: string | null }> {
  const label = subname.slice(0, subname.length - config.ens.parentName.length - 1);

  if (!chainReady) {
    console.log(`[ens:stub] chain not configured — not registering ${subname}`);
    return { txHash: `0xSTUB_ENS_${subname}` };
  }

  const { txHash } = await registerEnsLabelOnChain(WANTEST_SUBREGISTRY, label, owner as Address, SUBNAME_EXPIRY);
  if (txHash === null) {
    console.log(`[ens] ${subname} already registered — skipping`);
  } else {
    console.log(`[ens] registered ${subname} -> ${owner} (tx ${txHash})`);
  }
  return { txHash };
}
