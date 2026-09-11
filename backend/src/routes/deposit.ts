import { Router } from "express";
import { z } from "zod";
import { store } from "../store.js";
import { walletSubname, registerSubname } from "../ens.js";

/// POST /deposit — PRD §6.1 + §7.3. Cash lands in the box, backend fronts
/// JPYC from the treasury (Phase 1: real on-chain `depositFor` call — see
/// contracts/src/TakarabakoVault.sol) and registers/reuses the wallet's ENS
/// v2 subname under `wantest.eth`.
export const depositRouter = Router();

const DepositBody = z.object({
  amount: z.number().positive(),
  // Demo convenience: one box == one wallet handle for now. Phase 2 derives
  // this from the bound World ID nullifier once a user has signed up.
  handle: z.string().min(1).default("machina"),
});

depositRouter.post("/deposit", async (req, res) => {
  const parsed = DepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { amount, handle } = parsed.data;

  const ensName = walletSubname(handle);
  const wallet = store.getOrCreateWallet(handle, ensName);
  const wasNew = wallet.idleBalance === 0 && !wallet.nullifier;

  wallet.idleBalance += amount;

  let ensTxHash: string | undefined;
  if (wasNew) {
    ({ txHash: ensTxHash } = await registerSubname(ensName, wallet.boundAddress));
  }

  // TODO(Phase 1): vault.depositFor(wallet.boundAddress, amount) on-chain,
  // funded from the treasury signer; capture the real tx hash below.
  const depositTxHash = `0xSTUB_DEPOSIT_${Date.now()}`;
  store.logDeposit({
    id: crypto.randomUUID(),
    nullifier: wallet.nullifier,
    denomination: amount,
    txHash: depositTxHash,
    ts: Date.now(),
  });

  res.json({
    ensName,
    boundAddress: wallet.boundAddress,
    balance: wallet.idleBalance,
    txHash: depositTxHash,
    ensTxHash,
  });
});
