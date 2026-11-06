import { Router } from "express";
import { positionSummaries } from "../yieldPositions.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { ALIASES, LABELS, mbCall, multibaasReady } from "../multibaas.js";
import { config } from "../config.js";
import { balancesByChain, totalOf } from "../balances.js";

/// The customer's live vault value (principal + accrued yield): through
/// MultiBaas when it's configured, straight from the chain otherwise.
async function liveVaultValue(boundAddress: string): Promise<number | null> {
  const balances = await balancesByChain(boundAddress);
  if (!balances.length) return null;
  let total = totalOf(balances);
  if (multibaasReady) {
    // The primary chain's figure comes through MultiBaas.
    const raw = await mbCall<string>(ALIASES.vault, LABELS.vault, "previewValue", [boundAddress]).catch(() => null);
    if (raw !== null) total += Number(raw) / 1e6 - (balances.find((b) => b.chain === config.defaultChain)?.balance ?? 0); // USDC, 6 decimals
  }
  return total;
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
    name: p.name,
    pair: p.pair,
    riskTier: p.riskTier,
    label: p.label,
    apy: p.apyBps / 100,
    value: p.amount, // live, from the strategy's Aqua balances at today's ETH price
    inRange: p.inRange,
  }));

  res.json({ label: account.label, vaultValue: await liveVaultValue(account.boundAddress), positions });
}));
