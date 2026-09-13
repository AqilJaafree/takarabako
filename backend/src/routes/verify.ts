import { Router } from "express";
import { z } from "zod";
import { store } from "../store.js";
import { getOrCreateUserWallet } from "../privy.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /verify — PRD §6.2. Identity via Privy: the kiosk takes an email
/// on-screen, we look up (or create) that person's Privy user + embedded
/// wallet server-side, and bind the resulting Privy user id to the wallet
/// created in §6.1 — this is the sybil gate for the whole system (PRD §10).
/// No phone, no QR, no bridge/polling — this used to be World ID Selfie
/// Check, but its bridge handoff never got a phone to actually connect in
/// testing, so it was replaced.
export const verifyRouter = Router();

const VerifyBody = z.object({
  handle: z.string().min(1).default("machina"),
  email: z.string().email(),
});

verifyRouter.post("/verify", asyncHandler(async (req, res) => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { handle, email } = parsed.data;

  const wallet = store.getWallet(handle);
  if (!wallet) {
    res.status(404).json({ error: "no wallet for this box — deposit before verifying" });
    return;
  }

  const { userId, walletAddress, fundingTxHash } = await getOrCreateUserWallet(email);

  const isNewUser = !store.getUser(userId);
  store.createUser({
    privyUserId: userId,
    handle,
    boundAddress: wallet.boundAddress,
    privyWalletAddress: walletAddress,
    ensName: wallet.ensName,
    createdAt: isNewUser ? Date.now() : store.getUser(userId)!.createdAt,
  });
  store.bindWalletToUser(handle, userId);

  res.json({
    verified: true,
    ensName: wallet.ensName,
    userId,
    privyWalletAddress: walletAddress,
    reused: !isNewUser,
    fundingTxHash,
  });
}));
