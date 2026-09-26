import { parseUnits, stringToHex, formatUnits } from "viem";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ALIASES, LABELS, mbCall, mbSend, multibaasReady } from "./multibaas.js";

/// tkCASH (contracts/src/TakarabakoCashReceipt.sol) through MultiBaas: a
/// tokenized receipt for the banknotes in this kiosk's cash box. Minted to
/// the customer's Privy wallet when a note is accepted, burned when they
/// withdraw. All of it is additive — the vault flow never waits on or fails
/// because of tkCASH; errors are logged and the deposit carries on.

export const cashReceiptReady = multibaasReady && Boolean(config.cashReceiptAddress);

const TK_DECIMALS = 6;

/// bytes32 kiosk id, as the contract stores it ("tokyo-01" right-padded).
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
/// value of tkCASH against this kiosk's reserve. Idempotent per deposit.
export async function recordCashIn(d: { depositId: string; wallet: string; usdAmount: number; denomination: number; currency: string }) {
  if (!cashReceiptReady) return null;
  const { rows } = await pool.query("select tkcash_tx_hash from deposits where id = $1", [d.depositId]);
  if (rows[0]?.tkcash_tx_hash) return rows[0].tkcash_tx_hash as string;

  const hash = await mbSend(ALIASES.tkcash, LABELS.cashReceipt, "recordCashIn", [
    kioskIdBytes(),
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

/// Cash leaves the box: burn the customer's whole tkCASH balance against
/// kiosk reserves — the current kiosk first, then retired ones. Returns the
/// USD burned and the last burn's tx.
export async function redeemAll(wallet: string): Promise<{ burned: number; txHash: string | null }> {
  if (!cashReceiptReady) return { burned: 0, txHash: null };
  let left = BigInt(await mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "balanceOf", [wallet]));
  let burned = 0n;
  let txHash: string | null = null;
  for (const id of knownKioskIds()) {
    if (left === 0n) break;
    const kiosk = await kioskState(id);
    const amount = left < BigInt(kiosk.reserveRaw) ? left : BigInt(kiosk.reserveRaw);
    if (amount === 0n) continue;
    txHash = await mbSend(ALIASES.tkcash, LABELS.cashReceipt, "redeem", [kioskIdBytes(id), wallet, amount.toString()]);
    left -= amount;
    burned += amount;
  }
  return { burned: fromTkUnits(burned), txHash };
}

/// New customers may hold and move tkCASH: identity-verified via Privy.
export async function allowlist(wallet: string) {
  if (!cashReceiptReady) return null;
  return mbSend(ALIASES.tkcash, LABELS.cashReceipt, "setAllowlisted", [wallet, true]);
}

export interface KioskState {
  kioskId: string;
  active: boolean;
  frozen: boolean;
  reserve: number;
  reserveRaw: string;
  lastAuditAt: number | null; // unix seconds
}

export async function kioskState(kioskId = config.kioskId): Promise<KioskState> {
  // A public struct getter has four unnamed outputs; MultiBaas returns them
  // as an array (or an object keyed by position — accept either).
  const out = await mbCall<unknown>(ALIASES.tkcash, LABELS.cashReceipt, "kiosks", [kioskIdBytes(kioskId)]);
  const [active, frozen, reserveRaw, lastAuditAt] = (Array.isArray(out) ? out : Object.values(out as object)) as [boolean, boolean, string, string];
  return { kioskId, active, frozen, reserve: fromTkUnits(reserveRaw), reserveRaw, lastAuditAt: Number(lastAuditAt) || null };
}

export async function tkSupply() {
  const [supply, reserve, paused] = await Promise.all([
    mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "totalSupply"),
    mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "totalReserve"),
    mbCall<boolean>(ALIASES.tkcash, LABELS.cashReceipt, "paused"),
  ]);
  return { supply: fromTkUnits(supply), reserve: fromTkUnits(reserve), paused };
}
