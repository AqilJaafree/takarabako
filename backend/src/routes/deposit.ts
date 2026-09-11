import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { store } from "../store.js";
import { walletSubname, registerSubname } from "../ens.js";
import { chainReady, depositOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /deposit — PRD §6.1 + §7.3. Cash lands in the box, backend fronts
/// USDC from the treasury via a real on-chain `depositFor` call (see
/// contracts/src/TakarabakoVault.sol, wired up in chain.ts) and
/// registers/reuses the wallet's ENS v2 subname under `wantest.eth`
/// (still stubbed — ens.ts — pending a deployed registrar; PRD §7.7).
export const depositRouter = Router();

const DepositBody = z.object({
  amount: z.number().positive(),
  // Demo convenience: one box == one wallet handle for now. Phase 2 derives
  // this from the bound World ID nullifier once a user has signed up.
  handle: z.string().min(1).default("machina"),
});

depositRouter.post("/deposit", asyncHandler(async (req, res) => {
  const parsed = DepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { amount, handle } = parsed.data;

  const ensName = walletSubname(handle);
  const wallet = store.getOrCreateWallet(handle, ensName);
  const wasNew = wallet.idleBalance === 0 && !wallet.nullifier;

  let ensTxHash: string | undefined;
  if (wasNew) {
    ({ txHash: ensTxHash } = await registerSubname(ensName, wallet.boundAddress));
  }

  if (!chainReady) {
    res.status(503).json({ error: "chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS in backend/.env" });
    return;
  }

  const { txHash, value } = await depositOnChain(wallet.boundAddress as Address, amount);
  wallet.idleBalance = value;

  store.logDeposit({
    id: crypto.randomUUID(),
    nullifier: wallet.nullifier,
    denomination: amount,
    txHash,
    ts: Date.now(),
  });

  res.json({
    ensName,
    boundAddress: wallet.boundAddress,
    balance: wallet.idleBalance,
    txHash,
    ensTxHash,
  });
}));
