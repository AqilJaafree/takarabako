import { Router } from "express";
import { store } from "../store.js";

/// GET /position/:user — PRD §7.3, for the kiosk screen (PRD §7.2).
export const positionRouter = Router();

positionRouter.get("/position/:nullifier", (req, res) => {
  const { nullifier } = req.params;
  const user = store.getUser(nullifier);
  if (!user) {
    res.status(404).json({ error: "unknown user" });
    return;
  }

  const positions = store.getPositions(nullifier).map((p) => ({
    positionId: p.positionId,
    ensName: p.ensName,
    pair: p.pair,
    riskTier: p.riskTier,
    apy: p.apyBps / 100,
    value: p.amount, // Phase 1: read live value via vault.previewValue / position math
  }));

  res.json({ ensName: user.ensName, positions });
});
