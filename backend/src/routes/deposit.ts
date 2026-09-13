import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { store } from "../store.js";
import { chainReady, depositOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /deposit — PRD §6.2 (ATM-style: comes after /verify now). Cash
/// lands in the box, backend fronts USDC from the treasury via a real
/// on-chain `depositFor` call into the account's already-known
/// `boundAddress` (established at /verify time — see contracts/src/TakarabakoVault.sol,
/// wired up in chain.ts).
export const depositRouter = Router();

const DepositBody = z.object({
  userId: z.string().min(1),
  amount: z.number().positive(),
});

depositRouter.post("/deposit", asyncHandler(async (req, res) => {
  const parsed = DepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { userId, amount } = parsed.data;

  const account = store.getAccount(userId);
  if (!account) {
    res.status(404).json({ error: "unknown account — complete /verify first" });
    return;
  }
  if (!chainReady) {
    res.status(503).json({ error: "chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS in backend/.env" });
    return;
  }

  const { txHash, value } = await depositOnChain(account.boundAddress as Address, amount);
  account.idleBalance = value;

  store.logDeposit({
    id: crypto.randomUUID(),
    privyUserId: userId,
    denomination: amount,
    txHash,
    ts: Date.now(),
  });

  res.json({
    ensName: account.ensName,
    boundAddress: account.boundAddress,
    balance: account.idleBalance,
    txHash,
  });
}));
