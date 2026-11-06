import type { Account } from "./accounts.js";
import { createSession } from "./sessions.js";
import { totalBalance } from "./balances.js";
import { allowanceJson, dailyAllowance } from "./limits.js";

/// A deposit-only session at the cash terminal, and what the terminal shows.
/// Used by the wallet-QR login.
export async function depositLogin(account: Account) {
  const session = await createSession(account.privyUserId, "deposit");
  const balance = await totalBalance(account.boundAddress);
  return {
    userId: account.privyUserId,
    label: account.label,
    balance,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    limit: allowanceJson(await dailyAllowance(account)), // the deposit terminal shows what's left today
  };
}
