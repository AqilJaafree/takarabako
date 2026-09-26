import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { config } from "../config.js";
import { store } from "../store.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { recordWithdrawal } from "../history.js";
import { proposeExitAll } from "../agent.js";
import { chainReady, withdrawAllOnChain, treasuryAddress } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";
import { redeemAll } from "../cashReceipt.js";

/// POST /withdraw — PRD §6.6. Redeems every real vault share the user holds
/// via a real on-chain `withdrawTo` call, plus exits any real Uniswap agent
/// positions (decreaseLiquidity + collect on the actual LP NFT), all
/// settling to the dev/treasury wallet itself — not the user's own address
/// (PRD §6.6) — then applies the 2% cash-redemption fee, computed here
/// rather than in the vault.
export const withdrawRouter = Router();

const WithdrawBody = z.object({
  // "cash": USDC to the treasury and the customer collects cash (2% fee).
  // "wallet": USDC straight to the customer's Privy wallet (no cash handling, no fee).
  destination: z.enum(["cash", "wallet"]).default("cash"),
});

// Full-access sessions only (email login). A wallet-QR session is deposit-only.
withdrawRouter.post("/withdraw", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = WithdrawBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { destination } = parsed.data;
  const userId: string = res.locals.session.privyUserId;

  const account = await findByPrivyUserId(userId);
  if (!account) {
    res.status(404).json({ error: "unknown account — complete /verify first" });
    return;
  }
  if (!chainReady || !treasuryAddress) {
    res.status(503).json({ error: "chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS in backend/.env" });
    return;
  }

  const positions = store.getPositions(userId);
  const { grossUsdc: simulatedPositionsUsdc } = await proposeExitAll(positions);
  store.clearPositions(userId);

  const recipient = destination === "wallet" ? (account.privyWallet as Address) : treasuryAddress;
  const { txHash: vaultTxHash, amount: vaultUsdc } = await withdrawAllOnChain(account.boundAddress as Address, recipient);

  // tkCASH: the customer's claim on cash in the box ends here — as cash in
  // hand, or turned into USDC in their wallet (the notes then belong to the
  // treasury) — so their receipt tokens are burned either way.
  const tkcash = await redeemAll(account.privyWallet).catch((err) => {
    console.error(`[tkcash] redeem for ${userId}:`, err instanceof Error ? err.message : err);
    return { burned: 0, txHash: null };
  });

  const grossUsdc = simulatedPositionsUsdc + vaultUsdc;
  const feeBps = destination === "wallet" ? 0 : config.withdrawFeeBps;
  const fee = (grossUsdc * feeBps) / 10_000;
  const netUsdc = grossUsdc - fee;

  await recordWithdrawal({
    privyUserId: userId,
    destination,
    grossUsd: grossUsdc,
    feeBps,
    netUsd: netUsdc,
    txHash: vaultTxHash,
    tkcashBurned: tkcash.burned,
    tkcashTxHash: tkcash.txHash,
  });

  store.logWithdraw({
    id: crypto.randomUUID(),
    privyUserId: userId,
    grossUsdc,
    feeBps,
    netUsdc,
    ts: Date.now(),
  });

  res.json({
    positionsClosed: positions.length,
    vaultTxHash,
    grossUsdc,
    feeBps,
    netUsdc,
    destination,
    tkcashBurned: tkcash.burned,
    tkcashTxHash: tkcash.txHash,
    receipt:
      destination === "wallet"
        ? `$${grossUsdc.toFixed(2)} sent to your wallet ${account.privyWallet}`
        : `$${grossUsdc.toFixed(2)} -> ${feeBps / 100}% fee -> $${netUsdc.toFixed(2)} ready for pickup`,
  });
}));
