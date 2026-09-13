import { PrivyClient, NotFoundError, type LinkedAccount } from "@privy-io/node";
import type { Address } from "viem";
import { config } from "./config.js";
import { chainReady, fundWalletWithEthOnChain } from "./chain.js";

/// PRD §7.8 (revised) — Privy replaces World ID Selfie Check as the
/// identity/verification layer. World ID's bridge/QR handoff never
/// established a phone connection in testing (repeatedly stuck at
/// `waiting_for_connection` — see backend git history for the debugging
/// trail); Privy's server-side user+wallet creation needs no phone, no QR,
/// no bridge at all — the kiosk just takes an email on-screen.
///
/// Sybil-resistance signal: one email -> one Privy user (`getByEmailAddress`
/// finds an existing user before `create` would make a new one), which is
/// weaker than World ID's biometric uniqueness proof but real and simple.
/// This is a deliberate trade the user chose over continuing to debug the
/// World ID bridge.
const privy = new PrivyClient({
  appId: config.privy.appId,
  appSecret: config.privy.appSecret,
});

// Real Sepolia ETH gifted to a brand-new embedded wallet so the user has
// gas for anything they do with it themselves later. First-time account
// creation only (not every login) — real capital, kept bounded.
const NEW_ACCOUNT_FUNDING_ETH = 0.001;

export interface PrivyUserWallet {
  userId: string;
  walletAddress: string;
  fundingTxHash?: string;
}

function findEthereumWallet(linkedAccounts: LinkedAccount[]): string | undefined {
  const wallet = linkedAccounts.find((a) => a.type === "wallet" && a.chain_type === "ethereum");
  return wallet && "address" in wallet ? wallet.address : undefined;
}

/// Looks up the Privy user for `email`, creating one (with a fresh embedded
/// Ethereum wallet, funded with real Sepolia ETH) if none exists yet. Both
/// branches are real API calls — no local stubbing.
export async function getOrCreateUserWallet(email: string): Promise<PrivyUserWallet> {
  let linkedAccounts: LinkedAccount[];
  let userId: string;
  let isNewUser = false;

  try {
    const user = await privy.users().getByEmailAddress({ address: email });
    userId = user.id;
    linkedAccounts = user.linked_accounts;
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;

    const user = await privy.users().create({
      linked_accounts: [{ address: email, type: "email" }],
      wallets: [{ chain_type: "ethereum" }],
    });
    userId = user.id;
    linkedAccounts = user.linked_accounts;
    isNewUser = true;
  }

  const walletAddress = findEthereumWallet(linkedAccounts);
  if (!walletAddress) throw new Error(`Privy user ${userId} has no ethereum embedded wallet`);

  let fundingTxHash: string | undefined;
  if (isNewUser && chainReady) {
    try {
      const { txHash } = await fundWalletWithEthOnChain(walletAddress as Address, NEW_ACCOUNT_FUNDING_ETH);
      fundingTxHash = txHash;
    } catch (err) {
      // Don't fail account creation over a funding hiccup (e.g. treasury
      // low on ETH) — the user still has a real wallet, just no gas yet.
      console.error(`[privy] failed to fund new wallet ${walletAddress}:`, err);
    }
  }

  return { userId, walletAddress, fundingTxHash };
}
