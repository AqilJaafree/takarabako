import type { Address } from "viem";
import { deriveBoundAddress } from "./store.js";
import { findByPrivyUserId, insertAccount, markQrEmailed, type Account } from "./accounts.js";
import { createSession, type Session } from "./sessions.js";
import { sendQrEmail } from "./qrEmail.js";
import { chainReady, previewValueOnChain } from "./chain.js";
import { deriveEnsLabel, walletSubname, registerSubname } from "./ens.js";

/// Everything a full login does once the Privy user is known — shared by the
/// kiosk's email login (/verify) and the web app's Privy code login
/// (/auth/privy), so both register a customer identically.
export async function loginFull(user: { privyUserId: string; email: string; walletAddress: string }) {
  const { privyUserId, email, walletAddress } = user;

  let account: Account | null = await findByPrivyUserId(privyUserId);
  let ensTxHash: string | null = null;
  const isNew = !account;
  if (!account) {
    const boundAddress = deriveBoundAddress(privyUserId);
    const ensName = walletSubname(deriveEnsLabel(email));
    // Idempotent: an account registered before Postgres existed already owns
    // its name, and registerSubname skips it.
    ({ txHash: ensTxHash } = await registerSubname(ensName, boundAddress));
    account = await insertAccount({ privyUserId, email, privyWallet: walletAddress, boundAddress, ensName });
  }

  // First bind (including accounts that predate Postgres): email the QR once.
  // If the email can't be sent, the caller shows the QR on screen instead.
  let qrFallback: string | null = null;
  let qrEmailed = false;
  if (!account.qrEmailedAt) {
    const result = await sendQrEmail(email, account.privyWallet, account.ensName);
    if (result.sent) {
      await markQrEmailed(privyUserId);
      qrEmailed = true;
    } else {
      qrFallback = result.dataUrl;
    }
  }

  // Full access (deposit, yield, withdraw) only ever comes from an email login.
  const session: Session = await createSession(privyUserId, "full");
  const balance = chainReady ? await previewValueOnChain(account.boundAddress as Address) : 0;

  return {
    verified: true,
    userId: privyUserId,
    ensName: account.ensName,
    privyWalletAddress: account.privyWallet,
    balance,
    reused: !isNew,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    qrEmailed,
    qrFallback,
    ensTxHash,
  };
}
