import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { config } from "../config.js";
import { store } from "../store.js";
import { proposeExitAll } from "../agent.js";
import { chainReady, withdrawAllOnChain, treasuryAddress } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /withdraw — PRD §6.6. Redeems every real vault share the user holds
/// via a real on-chain `withdrawTo` call, plus exits any real Uniswap agent
/// positions (decreaseLiquidity + collect on the actual LP NFT), all
/// settling to the dev/treasury wallet itself — not the user's own address
/// (PRD §6.6) — then applies the 2% cash-redemption fee, computed here
/// rather than in the vault.
export const withdrawRouter = Router();

const WithdrawBody = z.object({
  userId: z.string().min(1),
});

withdrawRouter.post("/withdraw", asyncHandler(async (req, res) => {
  const parsed = WithdrawBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { userId } = parsed.data;

  const account = store.getAccount(userId);
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

  const { txHash: vaultTxHash, amount: vaultUsdc } = await withdrawAllOnChain(
    account.boundAddress as Address,
    treasuryAddress,
  );
  account.idleBalance = 0;

  const grossUsdc = simulatedPositionsUsdc + vaultUsdc;
  const feeBps = config.withdrawFeeBps;
  const fee = (grossUsdc * feeBps) / 10_000;
  const netUsdc = grossUsdc - fee;

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
    receipt: `$${grossUsdc.toFixed(2)} -> ${feeBps / 100}% fee -> $${netUsdc.toFixed(2)} ready for pickup`,
  });
}));
