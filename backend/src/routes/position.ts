import { Router } from "express";
import { store } from "../store.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";

/// GET /position — PRD §7.3, for the kiosk screen (PRD §7.2). The user
/// comes from the full-access session.
export const positionRouter = Router();

positionRouter.get("/position", requireSession("full"), asyncHandler(async (_req, res) => {
  const userId: string = res.locals.session.privyUserId;
  const account = await findByPrivyUserId(userId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }

  const positions = store.getPositions(userId).map((p) => ({
    positionId: p.positionId,
    ensName: p.ensName,
    pair: p.pair,
    riskTier: p.riskTier,
    apy: p.apyBps / 100,
    value: p.amount, // Phase 1: read live value via vault.previewValue / position math
  }));

  res.json({ ensName: account.ensName, positions });
}));
