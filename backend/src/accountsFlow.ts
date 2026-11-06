import { deriveBoundAddress } from "./store.js";
import { findByPrivyUserId, insertAccount, markQrEmailed, type Account } from "./accounts.js";
import { createSession, type Session } from "./sessions.js";
import { sendQrEmail } from "./qrEmail.js";
import { totalBalance } from "./balances.js";
import { deriveLabel } from "./labels.js";
import { allowlist } from "./cashReceipt.js";
import { config } from "./config.js";
import { multibaasReady, mbSetAlias, toAlias } from "./multibaas.js";

/// Everything a full login does once the Privy user is known — shared by the
/// kiosk's email login (/verify) and the web app's Privy code login
/// (/auth/privy), so both register a customer identically.
export async function loginFull(user: { privyUserId: string; email: string; walletAddress: string }) {
  const { privyUserId, email, walletAddress } = user;

  let account: Account | null = await findByPrivyUserId(privyUserId);
  const isNew = !account;
  if (!account) {
    const boundAddress = deriveBoundAddress(privyUserId);
    // The label is a friendly handle kept in Postgres; the wallet is the identity.
    const label = deriveLabel(email);
    account = await insertAccount({ privyUserId, email, privyWallet: walletAddress, boundAddress, label });
    onboardOnChain(label, walletAddress);
  }

  // First bind (including accounts that predate Postgres): email the QR once.
  // If the email can't be sent, the caller shows the QR on screen instead.
  let qrFallback: string | null = null;
  let qrEmailed = false;
  if (!account.qrEmailedAt) {
    const result = await sendQrEmail(email, account.privyWallet, account.label);
    if (result.sent) {
      await markQrEmailed(privyUserId);
      qrEmailed = true;
    } else {
      qrFallback = result.dataUrl;
    }
  }

  // Full access (deposit, yield, withdraw) only ever comes from an email login.
  const session: Session = await createSession(privyUserId, "full");
  const balance = await totalBalance(account.boundAddress);

  return {
    verified: true,
    userId: privyUserId,
    label: account.label,
    privyWalletAddress: account.privyWallet,
    balance,
    reused: !isNew,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    qrEmailed,
    qrFallback,
  };
}

/// A new, registered customer: allow their wallet to hold and move tkCASH on every
/// enabled chain, and give it a MultiBaas alias (their label) so the dashboard and
/// event queries show a name instead of an address. Background work: registration
/// never waits for it.
function onboardOnChain(label: string, wallet: string) {
  const log = (what: string) => (err: unknown) =>
    console.error(`[onboard] ${what} for ${label}:`, err instanceof Error ? err.message : err);
  for (const chain of config.enabledChains) {
    void allowlist(wallet, chain).catch(log(`tkCASH allowlist on ${chain}`));
  }
  if (multibaasReady) void mbSetAlias(toAlias(label), wallet).catch(log("alias"));
}
