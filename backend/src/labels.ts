import { keccak256, toBytes } from "viem";
import { pool } from "./db.js";

/// A customer's label comes from their email: the local part, cleaned to
/// letters, digits and hyphens, plus a short hash so two people with the same
/// local part get different labels. It is stored in Postgres (accounts.label)
/// and is only a friendly handle: the wallet address is the identity.
export function deriveLabel(email: string): string {
  const [localPart] = email.toLowerCase().split("@");
  const sanitized = (localPart ?? "user").replace(/[^a-z0-9-]/g, "").slice(0, 20) || "user";
  const disambiguator = keccak256(toBytes(email)).slice(2, 6);
  return `${sanitized}-${disambiguator}`;
}

/// "aqua-1a2b3c4d": the short tag a yield position shows in History.
export function positionLabel(positionId: string): string {
  return `aqua-${positionId.replace(/-/g, "").slice(0, 8)}`;
}

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

/// Wallet address or label to a Takarabako customer, from Postgres.
export async function findCustomer(q: string): Promise<{ privyUserId: string; label: string | null; wallet: string } | null> {
  const key = q.trim().toLowerCase();
  if (!key) return null;
  const { rows } = await pool.query(
    isAddress(key)
      ? "select privy_user_id as \"privyUserId\", label, privy_wallet as wallet from accounts where privy_wallet = $1"
      : "select privy_user_id as \"privyUserId\", label, privy_wallet as wallet from accounts where lower(label) = $1",
    [key],
  );
  return rows[0] ?? null;
}
