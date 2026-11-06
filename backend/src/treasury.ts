import { encodeFunctionData, parseAbi, stringToHex, type Address } from "viem";
import { config, isCashChain, type CashChainKey } from "./config.js";
import { chainOps, treasuryAddress } from "./chain.js";
import { ALIASES, LABELS, mbCall, mbQuery, mbSend } from "./multibaas.js";
import { advanceTransfer, createTransfer, getTransfer, validateAmount, validateRoute } from "./bridge.js";
import { cashReceiptReadyOn, fromTkUnits, kioskIdBytes, kioskState, knownKioskIds, tkSupply, tkWrite, viaMultibaas } from "./cashReceipt.js";
import { pool } from "./db.js";
import type { ProposalAction } from "./policy.js";

/// Treasury reads shared by the ops agent's tools and the dashboard, all
/// through MultiBaas, plus the executor for approved proposals.

const USDC = 1e6; // USDC has 6 decimals as an ERC-20 (Arc's native 18-decimal view is only for gas)
const RAY = 10n ** 18n; // the vault's exchange-rate scale

type Chain = CashChainKey;
const PRIMARY = (): Chain => config.defaultChain;

const vaultReadAbi = parseAbi([
  "function currentApyBps() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
]);
const erc20BalanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface VaultState {
  chain: Chain;
  apyBps: number;
  totalShares: number;
  liabilityUsd: number; // what every depositor could redeem right now
  vaultUsdcBalance: number; // USDC the vault actually holds
  reserveCoverage: number | null; // balance ÷ liability; below 1.0 the vault can't pay everyone
}

async function usdcBalanceOf(chain: Chain, holder: string): Promise<bigint> {
  if (viaMultibaas(chain)) return BigInt(await mbCall<string>(ALIASES.musdc, LABELS.usdc, "balanceOf", [holder]));
  return chainOps(chain).publicClient.readContract({
    address: config.chains[chain].usdcAddress as Address,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [holder as Address],
  });
}

export async function vaultState(chain: Chain = PRIMARY()): Promise<VaultState> {
  const vault = config.chains[chain].vaultAddress as Address;
  const read = async (fn: "currentApyBps" | "totalShares" | "exchangeRate"): Promise<string> =>
    viaMultibaas(chain)
      ? mbCall<string>(ALIASES.vault, LABELS.vault, fn)
      : String(await chainOps(chain).publicClient.readContract({ address: vault, abi: vaultReadAbi, functionName: fn }));
  const [apy, totalShares, exchangeRate, balance] = await Promise.all([
    read("currentApyBps"),
    read("totalShares"),
    read("exchangeRate"),
    usdcBalanceOf(chain, vault),
  ]);
  // exchangeRate is the last accrued rate; accrual since then is small for a demo-scale APY.
  const liabilityRaw = (BigInt(totalShares) * BigInt(exchangeRate)) / RAY;
  const liabilityUsd = Number(liabilityRaw) / USDC;
  const vaultUsdcBalance = Number(balance) / USDC;
  return {
    chain,
    apyBps: Number(apy),
    totalShares: Number(totalShares) / USDC,
    liabilityUsd,
    vaultUsdcBalance,
    reserveCoverage: liabilityUsd > 0 ? vaultUsdcBalance / liabilityUsd : null,
  };
}

/// The treasury's gas and USDC float on one chain. The native balance is read
/// straight from the chain, so the low-gas warning works before MultiBaas is
/// set up. On Arc the gas asset IS USDC (one pool of funds), so `usdc` is the
/// only figure to show there and `gasIsUsdc` says so: never add `native` to it.
export async function treasuryBalances(chain: Chain = PRIMARY()) {
  const ops = chainOps(chain);
  const native = ops.treasuryAddress ? await ops.treasuryEthBalance().catch(() => 0) : 0;
  const raw = ops.treasuryAddress ? await usdcBalanceOf(chain, ops.treasuryAddress).catch(() => null) : null;
  const usdc = raw === null ? null : Number(raw) / USDC;
  return {
    chain,
    address: ops.treasuryAddress ?? null,
    nativeSymbol: config.chains[chain].network.nativeSymbol,
    gasIsUsdc: isGasTokenUsdc(config.chains[chain].network),
    /// Below this the ops dashboard warns that the treasury is short of gas.
    gasMin: config.chains[chain].network.gas.treasuryMin,
    native,
    eth: native, // kept for older callers
    usdc,
    musdc: usdc,
  };
}

const isGasTokenUsdc = (n: { nativeSymbol: string }) => n.nativeSymbol === "USDC";

export interface Attestation {
  kioskId: string;
  counted: number;
  onChain: number;
  delta: number;
  at: string | null;
}

/// A bytes32 kiosk id as text. Event Queries return fixed bytes as a string
/// like "[107, 108, …]" (byte values); webhooks and calls give 0x-hex.
export function decodeKiosk(v: unknown): string {
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

export async function reserveAttestations(limit = 20, chain: Chain = PRIMARY()): Promise<Attestation[]> {
  const fromLog = async () => {
    const { rows } = await pool.query(
      "select inputs, triggered_at from chain_events where name = 'ReserveAttested' and chain = $2 order by triggered_at desc limit $1",
      [limit, chain],
    );
    return rows.map((r) => ({ ...r.inputs, at: r.triggered_at?.toISOString?.() ?? null }));
  };
  // The saved Event Query only exists on the chain MultiBaas serves; elsewhere,
  // and when setup hasn't run, the event log (webhook or log indexer) is the source.
  const rows = viaMultibaas(chain) ? await mbQuery<Record<string, unknown>>("reserve_attestations", limit).catch(fromLog) : await fromLog();
  return rows.map((r) => ({
    kioskId: decodeKiosk(r.kioskId ?? r.kioskid),
    counted: fromTkUnits(String(r.counted ?? "0")),
    onChain: fromTkUnits(String(r.onChain ?? r.onchain ?? "0")),
    delta: Number(r.delta ?? 0) / USDC,
    at: r.at ? String(r.at) : null,
  }));
}

export async function reserveStatus(chain: Chain = PRIMARY()) {
  if (!cashReceiptReadyOn(chain)) return { configured: false as const, chain };
  const [supply, kiosks, attestations] = await Promise.all([
    tkSupply(chain),
    Promise.all(knownKioskIds().map((id) => kioskState(id, chain))),
    reserveAttestations(5, chain),
  ]);
  return {
    configured: true as const,
    chain,
    ...supply,
    backed: Math.abs(supply.supply - supply.reserve) < 1e-6,
    kiosks,
    attestations,
  };
}

/// An operator counted a kiosk's cash box (proof of reserve). A count that
/// differs from the chain freezes the kiosk's minting, on-chain.
export async function attestReserve(kioskId: string, countedUsd: number, auditRef: string, chain: Chain = PRIMARY()) {
  return tkWrite(chain, "attestReserve", [
    kioskIdBytes(kioskId),
    BigInt(Math.round(countedUsd * USDC)).toString(),
    stringToHex(auditRef.slice(0, 31), { size: 32 }),
  ]);
}

/// A human resolved a count mismatch.
export async function unfreezeKiosk(kioskId: string, chain: Chain = PRIMARY()) {
  return tkWrite(chain, "unfreezeKiosk", [kioskIdBytes(kioskId)]);
}

async function rebalance(args: Record<string, unknown>): Promise<string> {
  const route = validateRoute(String(args.from), String(args.to));
  validateAmount(Number(args.amount));
  const t = await createTransfer({ privyUserId: null, kind: "treasury", from: route.from, to: route.to, amountUsd: Number(args.amount), recipient: chainOps(route.to).treasuryAddress ?? "" });
  // The burn is sent now; the mint follows once Circle attests (the bridge worker finishes it).
  await advanceTransfer(t.id);
  const after = await getTransfer(t.id);
  if (after?.state === "failed") throw new Error(after.error ?? "bridge transfer failed");
  return after?.burnTx ?? t.id;
}

const vaultWriteAbi = parseAbi(["function fundYieldReserve(uint256 amount)", "function setApyBps(uint256 newApyBps)"]);

function chainArg(args: Record<string, unknown>): Chain {
  const c = String(args.chain ?? PRIMARY());
  if (!isCashChain(c)) throw new Error(`unknown chain "${c}"`);
  return c;
}

/// Executes an approved proposal (signed by the treasury): through MultiBaas
/// on the chain it serves, directly over RPC elsewhere.
export async function executeProposal(action: ProposalAction, args: Record<string, unknown>): Promise<string> {
  if (action === "rebalance_chains") return rebalance(args);
  const chain = chainArg(args);
  const usdcUnits = (n: unknown) => BigInt(Math.round(Number(n) * USDC));
  const ops = chainOps(chain);
  const vault = config.chains[chain].vaultAddress as Address;
  switch (action) {
    case "fund_yield_reserve":
      if (viaMultibaas(chain)) return mbSend(ALIASES.vault, LABELS.vault, "fundYieldReserve", [usdcUnits(args.amount).toString()]);
      await ops.ensureVaultApproval();
      return ops.sendTreasuryTx({ to: vault, data: encodeFunctionData({ abi: vaultWriteAbi, functionName: "fundYieldReserve", args: [usdcUnits(args.amount)] }) });
    case "set_apy":
      if (viaMultibaas(chain)) return mbSend(ALIASES.vault, LABELS.vault, "setApyBps", [String(args.bps)]);
      return ops.sendTreasuryTx({ to: vault, data: encodeFunctionData({ abi: vaultWriteAbi, functionName: "setApyBps", args: [BigInt(String(args.bps))] }) });
    case "mint_usdc_float":
      // Only a mock USDC can be minted; Arc's USDC is Circle's own (faucet instead).
      if (chain !== "sepolia" || !viaMultibaas(chain)) throw new Error("USDC float on this chain comes from the Circle faucet, not a mint");
      if (!treasuryAddress) throw new Error("treasury not configured");
      return mbSend(ALIASES.musdc, LABELS.usdc, "mint", [treasuryAddress, usdcUnits(args.amount).toString()]);
    case "pause_kiosk":
      return tkWrite(chain, "setKiosk", [kioskIdBytes(String(args.kioskId)), false]);
  }
}
