import { Router } from "express";
import { z } from "zod";
import { store, deriveBoundAddress } from "../store.js";
import { getOrCreateUserWallet } from "../privy.js";
import { deriveEnsLabel, walletSubname, registerSubname } from "../ens.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /verify — PRD §6.1 (ATM-style: identity first, cash second). Takes
/// an email on the kiosk screen, resolves (or creates) that person's real
/// Privy user + embedded wallet server-side, and — for a brand-new
/// account — registers their ENS v2 subname right here, before any cash
/// has been inserted. This is the sybil gate for the whole system (PRD
/// §10): like a real ATM, you identify yourself before the machine knows
/// which account to credit, rather than depositing blind and hoping the
/// right person claims it afterward.
export const verifyRouter = Router();

const VerifyBody = z.object({
  email: z.string().email(),
});

verifyRouter.post("/verify", asyncHandler(async (req, res) => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { email } = parsed.data;

  const { userId, walletAddress, fundingTxHash } = await getOrCreateUserWallet(email);

  const existing = store.getAccount(userId);
  if (existing) {
    res.json({
      verified: true,
      userId,
      ensName: existing.ensName,
      boundAddress: existing.boundAddress,
      privyWalletAddress: existing.privyWalletAddress,
      balance: existing.idleBalance,
      reused: true,
    });
    return;
  }

  const boundAddress = deriveBoundAddress(userId);
  const ensName = walletSubname(deriveEnsLabel(email));
  const { txHash: ensTxHash } = await registerSubname(ensName, boundAddress);

  store.createAccount({
    privyUserId: userId,
    ensName,
    boundAddress,
    privyWalletAddress: walletAddress,
    idleBalance: 0,
    createdAt: Date.now(),
  });

  res.json({
    verified: true,
    userId,
    ensName,
    boundAddress,
    privyWalletAddress: walletAddress,
    balance: 0,
    reused: false,
    fundingTxHash,
    ensTxHash,
  });
}));
