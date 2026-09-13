import { Router } from "express";
import { z } from "zod";
import { store } from "../store.js";
import { positionSubname, registerSubname } from "../ens.js";
import { proposeOpenPosition } from "../agent.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /agent/open-position — PRD §6.4 + §7.9. Routes idle USDC into the
/// Claude Haiku agent's risk-tiered Uniswap v3/v4 position management, then
/// registers the position's own ENS v2 subname (`uniswap-{positionId}.wantest.eth`).
export const agentRouter = Router();

const OpenPositionBody = z.object({
  userId: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high"]),
  amount: z.number().positive(),
});

agentRouter.post("/agent/open-position", asyncHandler(async (req, res) => {
  const parsed = OpenPositionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { userId, riskLevel, amount } = parsed.data;

  const user = store.getUser(userId);
  if (!user) {
    res.status(404).json({ error: "unknown user — complete /verify first" });
    return;
  }

  const proposal = await proposeOpenPosition(riskLevel, amount);

  const position = store.addPosition({
    ensName: "", // filled in below once the id is assigned
    user: userId,
    riskTier: riskLevel,
    pair: proposal.pair,
    amount,
    apyBps: proposal.apyBps,
    openedAt: Date.now(),
    nftTokenId: proposal.tokenId,
  });

  const ensName = positionSubname(position.positionId);
  position.ensName = ensName;
  await registerSubname(ensName, user.boundAddress);

  res.json({
    positionId: position.positionId,
    ensName,
    pair: position.pair,
    apyBps: position.apyBps,
    nftTokenId: proposal.tokenId,
    txHash: proposal.txHash,
  });
}));
