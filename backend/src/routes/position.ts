import { Router } from "express";
import { positionSummaries } from "../yieldPositions.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { ALIASES, LABELS, mbCall, multibaasReady } from "../multibaas.js";
import { chainReady, previewValueOnChain } from "../chain.js";

/// The customer's live vault value (principal + accrued yield): through
/// MultiBaas when it's configured, straight from the chain otherwise.
async function liveVaultValue(boundAddress: string): Promise<number | null> {
  if (multibaasReady) {
    const raw = await mbCall<string>(ALIASES.vault, LABELS.vault, "previewValue", [boundAddress]).catch(() => null);
    if (raw !== null) return Number(raw) / 1e6; // USDC, 6 decimals
  }
  return chainReady ? previewValueOnChain(boundAddress as `0x${string}`) : null;
}

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

  const positions = (await positionSummaries(userId)).map((p) => ({
    positionId: p.positionId,
    ensName: p.ensName,
    pair: p.pair,
    riskTier: p.riskTier,
    label: p.label,
    apy: p.apyBps / 100,
    value: p.amount, // live, from the strategy's Aqua balances at today's ETH price
    inRange: p.inRange,
  }));

  res.json({ ensName: account.ensName, vaultValue: await liveVaultValue(account.boundAddress), positions });
}));
