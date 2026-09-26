import { randomBytes } from "node:crypto";
import { redis } from "./redis.js";
import { findByPrivyUserId, type Account } from "./accounts.js";

/// Rotating deposit QR (the web app's Deposit tab). Instead of the account's
/// fixed wallet address, the QR carries a random code that logs in to a
/// deposit-only session for 5 minutes. Each account has one live code:
/// issuing a new one kills the last, so a screenshot stops working as soon
/// as the customer opens Deposit again. A code works for several scans until
/// it expires or is replaced, so a failed scan doesn't mean a new QR.

export const DEPOSIT_CODE_TTL_S = 300;
export const DEPOSIT_QR_PREFIX = "takarabako:deposit:";

const codeKey = (code: string) => `depositqr:${code}`;
const userKey = (privyUserId: string) => `depositqr:user:${privyUserId}`;
const CODE_FORMAT = /^[A-Za-z0-9_-]{32}$/;

export async function issueDepositCode(privyUserId: string) {
  const code = randomBytes(24).toString("base64url"); // 32 chars
  const previous = await redis.get(userKey(privyUserId));
  // Not atomic, and doesn't need to be: two issues racing leave at most one
  // extra code, which still dies within DEPOSIT_CODE_TTL_S.
  await redis.set(codeKey(code), privyUserId, "EX", DEPOSIT_CODE_TTL_S);
  await redis.set(userKey(privyUserId), code, "EX", DEPOSIT_CODE_TTL_S);
  if (previous) await redis.del(codeKey(previous));
  return {
    qr: `${DEPOSIT_QR_PREFIX}${code}`,
    expiresAt: new Date(Date.now() + DEPOSIT_CODE_TTL_S * 1000),
    ttlSeconds: DEPOSIT_CODE_TTL_S,
  };
}

export const isDepositQr = (text: string) => text.trim().startsWith(DEPOSIT_QR_PREFIX);

export type DepositQrOutcome =
  | { ok: true; account: Account }
  | { ok: false; status: 404 | 410; error: string };

/// The account a scanned deposit QR belongs to. Expired, replaced and
/// malformed codes all read as expired: the fix is the same (a fresh QR).
export async function accountForDepositQr(text: string): Promise<DepositQrOutcome> {
  const code = text.trim().slice(DEPOSIT_QR_PREFIX.length);
  const privyUserId = CODE_FORMAT.test(code) ? await redis.get(codeKey(code)) : null;
  if (!privyUserId) {
    return { ok: false, status: 410, error: "This QR has expired. Open Deposit on your phone for a new one." };
  }
  const account = await findByPrivyUserId(privyUserId);
  if (!account) return { ok: false, status: 404, error: "This QR isn't registered. Sign up with your email first." };
  return { ok: true, account };
}
