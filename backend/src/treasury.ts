import { stringToHex } from "viem";
import { config } from "./config.js";
import { treasuryAddress, treasuryEthBalance } from "./chain.js";
import { ALIASES, LABELS, mbCall, mbQuery, mbSend, multibaasReady } from "./multibaas.js";
import { cashReceiptReady, fromTkUnits, kioskIdBytes, kioskState, knownKioskIds, tkSupply } from "./cashReceipt.js";
import { pool } from "./db.js";
import type { ProposalAction } from "./policy.js";

/// Treasury reads shared by the ops agent's tools and the dashboard, all
/// through MultiBaas, plus the executor for approved proposals.

const USDC = 1e6; // mUSDC has 6 decimals
const RAY = 10n ** 18n; // the vault's exchange-rate scale

export interface VaultState {
  apyBps: number;
  totalShares: number;
  liabilityUsd: number; // what every depositor could redeem right now
  vaultUsdcBalance: number; // USDC the vault actually holds
  reserveCoverage: number | null; // balance ÷ liability; below 1.0 the vault can't pay everyone
}

export async function vaultState(): Promise<VaultState> {
  const [apy, totalShares, exchangeRate, balance] = await Promise.all([
    mbCall<string>(ALIASES.vault, LABELS.vault, "currentApyBps"),
    mbCall<string>(ALIASES.vault, LABELS.vault, "totalShares"),
    mbCall<string>(ALIASES.vault, LABELS.vault, "exchangeRate"),
    mbCall<string>(ALIASES.musdc, LABELS.usdc, "balanceOf", [config.vaultAddress]),
  ]);
  // exchangeRate is the last accrued rate; accrual since then is small for a demo-scale APY.
  const liabilityRaw = (BigInt(totalShares) * BigInt(exchangeRate)) / RAY;
  const liabilityUsd = Number(liabilityRaw) / USDC;
  const vaultUsdcBalance = Number(balance) / USDC;
  return {
    apyBps: Number(apy),
    totalShares: Number(totalShares) / USDC,
    liabilityUsd,
    vaultUsdcBalance,
    reserveCoverage: liabilityUsd > 0 ? vaultUsdcBalance / liabilityUsd : null,
  };
}

/// ETH is read straight from the chain, so the low-gas warning works even
/// before MultiBaas is set up; the mUSDC float needs MultiBaas.
export async function treasuryBalances() {
  const [eth, usdc] = await Promise.all([
    treasuryEthBalance(),
    treasuryAddress && multibaasReady
      ? mbCall<string>(ALIASES.musdc, LABELS.usdc, "balanceOf", [treasuryAddress])
      : Promise.resolve(null),
  ]);
  return { address: treasuryAddress ?? null, eth, musdc: usdc === null ? null : Number(usdc) / USDC };
}

export interface Attestation {
  kioskId: string;
  counted: number;
  onChain: number;
  delta: number;
  at: string | null;
}

/// A bytes32 kiosk id as text. Event Queries return fixed bytes as a string
/// like "[107, 108, …]" (byte values); webhooks and calls give 0x-hex.
function decodeKiosk(v: unknown): string {
  if (typeof v === "string" && v.startsWith("[")) {
    try {
      v = JSON.parse(v);
    } catch {}
  }
  const bytes = Array.isArray(v)
    ? Buffer.from(v.map(Number))
    : typeof v === "string" && v.startsWith("0x")
      ? Buffer.from(v.slice(2), "hex")
      : null;
  if (!bytes) return String(v ?? "");
  return bytes.toString("utf8").replace(/\0+$/, "");
}

export async function reserveAttestations(limit = 20): Promise<Attestation[]> {
  const rows = await mbQuery<Record<string, unknown>>("reserve_attestations", limit).catch(async () => {
    // The saved query isn't there (setup not run yet): use the webhook log.
    const { rows } = await pool.query(
      "select inputs, triggered_at from chain_events where name = 'ReserveAttested' order by triggered_at desc limit $1",
      [limit],
    );
    return rows.map((r) => ({ ...r.inputs, at: r.triggered_at?.toISOString?.() ?? null }));
  });
  return rows.map((r) => ({
    kioskId: decodeKiosk(r.kioskId ?? r.kioskid),
    counted: fromTkUnits(String(r.counted ?? "0")),
    onChain: fromTkUnits(String(r.onChain ?? r.onchain ?? "0")),
    delta: Number(r.delta ?? 0) / USDC,
    at: r.at ? String(r.at) : null,
  }));
}

export async function reserveStatus() {
  if (!cashReceiptReady) return { configured: false as const };
  const [supply, kiosks, attestations] = await Promise.all([tkSupply(), Promise.all(knownKioskIds().map((id) => kioskState(id))), reserveAttestations(5)]);
  return {
    configured: true as const,
    ...supply,
    backed: Math.abs(supply.supply - supply.reserve) < 1e-6,
    kiosks,
    attestations,
  };
}

/// An operator counted a kiosk's cash box (proof of reserve). A count that
/// differs from the chain freezes the kiosk's minting, on-chain.
export async function attestReserve(kioskId: string, countedUsd: number, auditRef: string) {
  return mbSend(ALIASES.tkcash, LABELS.cashReceipt, "attestReserve", [
    kioskIdBytes(kioskId),
    BigInt(Math.round(countedUsd * USDC)).toString(),
    stringToHex(auditRef.slice(0, 31), { size: 32 }),
  ]);
}

/// A human resolved a count mismatch.
export async function unfreezeKiosk(kioskId: string) {
  return mbSend(ALIASES.tkcash, LABELS.cashReceipt, "unfreezeKiosk", [kioskIdBytes(kioskId)]);
}

/// Executes an approved proposal through MultiBaas (signed by the treasury).
export async function executeProposal(action: ProposalAction, args: Record<string, unknown>): Promise<string> {
  const usdcUnits = (n: unknown) => BigInt(Math.round(Number(n) * USDC)).toString();
  switch (action) {
    case "fund_yield_reserve":
      return mbSend(ALIASES.vault, LABELS.vault, "fundYieldReserve", [usdcUnits(args.amount)]);
    case "set_apy":
      return mbSend(ALIASES.vault, LABELS.vault, "setApyBps", [String(args.bps)]);
    case "mint_usdc_float":
      if (!treasuryAddress) throw new Error("treasury not configured");
      return mbSend(ALIASES.musdc, LABELS.usdc, "mint", [treasuryAddress, usdcUnits(args.amount)]);
    case "pause_kiosk":
      return mbSend(ALIASES.tkcash, LABELS.cashReceipt, "setKiosk", [kioskIdBytes(String(args.kioskId)), false]);
  }
}
