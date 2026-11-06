import { parseUnits, parseAbi, stringToHex, formatUnits, encodeFunctionData, type Address } from "viem";
import { config, type CashChainKey } from "./config.js";
import { pool } from "./db.js";
import { ALIASES, LABELS, mbCall, mbSend, multibaasReady } from "./multibaas.js";
import { chainOps } from "./chain.js";

/// tkCASH (contracts/src/TakarabakoCashReceipt.sol): a tokenized receipt for
/// the banknotes in a kiosk's cash box. Minted to the customer's Privy wallet
/// when a note is accepted, burned when they withdraw. All of it is additive:
/// the vault flow never waits on or fails because of tkCASH; errors are logged
/// and the deposit carries on.
///
/// There is one tkCASH per chain. On the primary chain with MultiBaas
/// configured, calls go through MultiBaas (unsigned tx from its contract API,
/// signed locally). Everywhere else (Arc Testnet) the same ABI is called
/// directly over the chain's RPC and signed with the same treasury key.

const tkAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalReserve() view returns (uint256)",
  "function paused() view returns (bool)",
  "function allowlist(address) view returns (bool)",
  "function dailyTransferLimit() view returns (uint256)",
  "function spentToday(address) view returns (uint256)",
  "function spentDay(address) view returns (uint256)",
  "function kiosks(bytes32) view returns (bool active, bool frozen, uint256 reserve, uint64 lastAuditAt)",
  "function recordCashIn(bytes32 kioskId, address user, uint256 amount, uint32 denomination, bytes3 currency)",
  "function redeem(bytes32 kioskId, address user, uint256 amount)",
  "function setAllowlisted(address account, bool allowed)",
  "function setDailyTransferLimit(uint256 limit)",
  "function attestReserve(bytes32 kioskId, uint256 counted, bytes32 auditRef)",
  "function unfreezeKiosk(bytes32 kioskId)",
  "function setKiosk(bytes32 kioskId, bool active)",
]);

type Chain = CashChainKey;
const PRIMARY = (): Chain => config.defaultChain;
export const viaMultibaas = (chain: Chain) => multibaasReady && chain === PRIMARY();
const tkAddress = (chain: Chain) => config.chains[chain].cashReceiptAddress as Address;

/// Is tkCASH usable on this chain (default: the primary chain)?
export function cashReceiptReadyOn(chain: Chain = PRIMARY()): boolean {
  if (!tkAddress(chain)) return false;
  return viaMultibaas(chain) || chainOps(chain).chainReady;
}
export const cashReceiptReady = cashReceiptReadyOn();

/// A view call. Numbers come back as decimal strings on both paths.
export async function tkRead<T = unknown>(chain: Chain, method: string, args: unknown[] = []): Promise<T> {
  if (viaMultibaas(chain)) return mbCall<T>(ALIASES.tkcash, LABELS.cashReceipt, method, args);
  const out = await chainOps(chain).publicClient.readContract({
    address: tkAddress(chain),
    abi: tkAbi,
    functionName: method as never,
    args: args as never,
  });
  return stringify(out) as T;
}

/// A treasury write; resolves with the mined tx hash.
export async function tkWrite(chain: Chain, method: string, args: unknown[] = []): Promise<`0x${string}`> {
  if (viaMultibaas(chain)) return mbSend(ALIASES.tkcash, LABELS.cashReceipt, method, args);
  const ops = chainOps(chain);
  const data = encodeFunctionData({ abi: tkAbi, functionName: method as never, args: args.map(coerce) as never });
  return ops.sendTreasuryTx({ to: tkAddress(chain), data });
}

const stringify = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(stringify) : v;
const coerce = (v: unknown): unknown => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v);

const TK_DECIMALS = 6;

/// bytes32 kiosk id, as the contract stores it ("mumbai-01" right-padded).
export function kioskIdBytes(kioskId = config.kioskId): `0x${string}` {
  return stringToHex(kioskId, { size: 32 });
}

/// bytes3 currency code ("MYR").
export function currencyBytes(currency: string): `0x${string}` {
  return stringToHex(currency.slice(0, 3).toUpperCase(), { size: 3 });
}

export function toTkUnits(usd: number): string {
  return parseUnits(usd.toFixed(TK_DECIMALS), TK_DECIMALS).toString();
}

export function fromTkUnits(raw: string | bigint): number {
  return Number(formatUnits(BigInt(raw), TK_DECIMALS));
}

/// A note was accepted and its vault deposit confirmed: mint the same USD
/// value of tkCASH against this kiosk's reserve, on the chain the note went
/// to. Idempotent per deposit.
export async function recordCashIn(d: { depositId: string; wallet: string; usdAmount: number; denomination: number; currency: string; chain?: Chain; kioskId?: string }) {
  const chain = d.chain ?? PRIMARY();
  if (!cashReceiptReadyOn(chain)) return null;
  const { rows } = await pool.query("select tkcash_tx_hash from deposits where id = $1", [d.depositId]);
  if (rows[0]?.tkcash_tx_hash) return rows[0].tkcash_tx_hash as string;

  const hash = await tkWrite(chain, "recordCashIn", [
    kioskIdBytes(d.kioskId),
    d.wallet,
    toTkUnits(d.usdAmount),
    Math.round(d.denomination),
    currencyBytes(d.currency),
  ]);
  await pool.query("update deposits set tkcash_tx_hash = $2 where id = $1", [d.depositId, hash]);
  return hash;
}

/// Every kiosk this backend knows: the current one first, then retired ones
/// whose reserve is still redeemable.
export const knownKioskIds = () => [config.kioskId, ...config.previousKioskIds.filter((k) => k !== config.kioskId)];

/// Cash leaves the box: burn the customer's whole tkCASH balance on `chain`
/// against kiosk reserves, the current kiosk first, then retired ones.
/// Returns the USD burned and the last burn's tx.
export async function redeemAll(wallet: string, chain: Chain = PRIMARY()): Promise<{ burned: number; txHash: string | null }> {
  if (!cashReceiptReadyOn(chain)) return { burned: 0, txHash: null };
  let left = BigInt(await tkRead<string>(chain, "balanceOf", [wallet]));
  let burned = 0n;
  let txHash: string | null = null;
  for (const id of knownKioskIds()) {
    if (left === 0n) break;
    const kiosk = await kioskState(id, chain);
    const amount = left < BigInt(kiosk.reserveRaw) ? left : BigInt(kiosk.reserveRaw);
    if (amount === 0n) continue;
    txHash = await tkWrite(chain, "redeem", [kioskIdBytes(id), wallet, amount.toString()]);
    left -= amount;
    burned += amount;
  }
  return { burned: fromTkUnits(burned), txHash };
}

/// New customers may hold and move tkCASH. Allowlisting a wallet is a plain
/// treasury transaction, so it is done on every chain that has a tkCASH.
export async function allowlist(wallet: string, chain: Chain = PRIMARY()) {
  if (!cashReceiptReadyOn(chain)) return null;
  return tkWrite(chain, "setAllowlisted", [wallet, true]);
}

export interface KioskState {
  kioskId: string;
  active: boolean;
  frozen: boolean;
  reserve: number;
  reserveRaw: string;
  lastAuditAt: number | null; // unix seconds
}

export async function kioskState(kioskId = config.kioskId, chain: Chain = PRIMARY()): Promise<KioskState> {
  // A public struct getter has four outputs; MultiBaas returns them as an
  // array (or an object keyed by position), viem as a tuple. Accept either.
  const out = await tkRead<unknown>(chain, "kiosks", [kioskIdBytes(kioskId)]);
  const [active, frozen, reserveRaw, lastAuditAt] = (Array.isArray(out) ? out : Object.values(out as object)) as [boolean, boolean, string, string];
  return { kioskId, active, frozen, reserve: fromTkUnits(reserveRaw), reserveRaw: String(reserveRaw), lastAuditAt: Number(lastAuditAt) || null };
}

export async function tkSupply(chain: Chain = PRIMARY()) {
  const [supply, reserve, paused] = await Promise.all([
    tkRead<string>(chain, "totalSupply"),
    tkRead<string>(chain, "totalReserve"),
    tkRead<boolean>(chain, "paused"),
  ]);
  return { supply: fromTkUnits(supply), reserve: fromTkUnits(reserve), paused };
}
