import { Router } from "express";
import { z } from "zod";
import { store } from "../store.js";
import { verifyProof } from "../worldId.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /verify — PRD §6.2. Verifies a World ID Selfie Check proof
/// server-side (against the Sandbox simulator in dev) and binds the
/// resulting nullifier to the wallet created in §6.1 — this is the sybil
/// gate for the whole system (PRD §10).
export const verifyRouter = Router();

const VerifyBody = z.object({
  handle: z.string().min(1).default("machina"),
  worldIdProof: z.object({
    nullifier_hash: z.string(),
    merkle_root: z.string(),
    proof: z.string(),
    verification_level: z.string(),
  }),
});

verifyRouter.post("/verify", asyncHandler(async (req, res) => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { handle, worldIdProof } = parsed.data;

  const wallet = store.getWallet(handle);
  if (!wallet) {
    res.status(404).json({ error: "no wallet for this box — deposit before verifying" });
    return;
  }

  const result = await verifyProof(worldIdProof);
  if (!result.valid) {
    res.status(401).json({ error: "invalid World ID proof" });
    return;
  }

  const isNewNullifier = !store.getUser(result.nullifierHash);
  store.createUser({
    worldIdNullifier: result.nullifierHash,
    handle,
    boundAddress: wallet.boundAddress,
    ensName: wallet.ensName,
    createdAt: isNewNullifier ? Date.now() : store.getUser(result.nullifierHash)!.createdAt,
  });
  store.bindWalletToNullifier(handle, result.nullifierHash);

  res.json({
    verified: true,
    ensName: wallet.ensName,
    nullifierHash: result.nullifierHash,
    reused: !isNewNullifier,
  });
}));
