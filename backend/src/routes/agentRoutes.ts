import { Router } from "express";
import { z } from "zod";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { getTiersInfo, tierRationale } from "../agent.js";
import { ethUsd } from "../aqua.js";
import { openForCustomer } from "../yieldPositions.js";
import { asyncHandler } from "../asyncHandler.js";

/// The beginner yield tiers, on 1inch Aqua (ETH/USDC strategies shipped by
/// the treasury). Route names are kept from the Uniswap version so the
/// kiosk and web app call the same endpoints.
export const agentRouter = Router();

/// GET /agent/pools — the three tiers with ranges placed around today's price.
agentRouter.get("/agent/pools", asyncHandler(async (_req, res) => {
  const spot = await ethUsd().catch(() => null);
  res.json({ spot, pools: getTiersInfo(spot) });
}));

const OpenPositionBody = z.object({
  riskLevel: z.enum(["low", "medium", "high"]),
  amount: z.number().positive(),
});

agentRouter.post("/agent/open-position", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = OpenPositionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { riskLevel, amount } = parsed.data;
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account — complete /verify first" });
    return;
  }
  const rationale = await tierRationale(riskLevel, amount, await ethUsd());
  const { position, ensName } = await openForCustomer(account, { mode: riskLevel, amount, rationale });
  res.json({
    positionId: position.id,
    ensName,
    pair: `ETH/USDC · ${position.label}`,
    apyBps: position.apyEstBps,
    txHash: position.vaultTx,
    rationale,
    position,
  });
}));
