import { Router } from "express";
import { z } from "zod";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { getTiersInfo } from "../agent.js";
import { ethCandles, ethUsd, listPositions, PAIR, planPosition, viewPosition } from "../aqua.js";
import { ADVANCED, allocate } from "../aquaMath.js";
import { closeForCustomer, openForCustomer } from "../yieldPositions.js";
import { holdsDeed } from "../ensTransfers.js";

/// 1inch Aqua yield for the web app: market data for the chart, a preview
/// of how a range splits into liquidity, advanced positions and closing.
export const yieldRouter = Router();

/// GET /yield/market — ETH price, a week of hourly candles, the tiers and the advanced limits.
yieldRouter.get("/yield/market", asyncHandler(async (_req, res) => {
  const [spot, candles] = await Promise.all([ethUsd(), ethCandles().catch(() => [])]);
  res.json({
    spot,
    candles,
    tiers: getTiersInfo(spot),
    advanced: {
      minPrice: spot * ADVANCED.minFractionOfSpot,
      maxPrice: spot * ADVANCED.maxMultipleOfSpot,
      feeBps: ADVANCED.feeBps,
      apyEstBps: ADVANCED.apyEstBps,
      bins: ADVANCED.bins,
    },
    pair: { eth: PAIR.eth.address, usdc: PAIR.usdc.address },
  });
}));

const Advanced = z.object({
  amount: z.number().positive(),
  shape: z.enum(["spot", "curve", "bidask"]),
  priceMin: z.number().positive(),
  priceMax: z.number().positive(),
});

/// POST /yield/preview — how an advanced range would split into bins and tokens (no chain calls).
yieldRouter.post("/yield/preview", asyncHandler(async (req, res) => {
  const parsed = Advanced.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const spot = await ethUsd();
  try {
    const plan = planPosition({ mode: "advanced", ...parsed.data }, spot);
    const bins = plan.bins.map((b) => {
      const usd = parsed.data.amount * (b?.weight ?? 1);
      const { eth, usdc } = allocate(usd, b, spot, PAIR);
      return { min: b?.min ?? null, max: b?.max ?? null, weight: b?.weight ?? 1, usd, eth: Number(eth) / 1e18, usdc: Number(usdc) / 1e6 };
    });
    const side = bins.every((b) => b.eth === 0) ? "usdc" : bins.every((b) => b.usdc === 0) ? "eth" : "both";
    res.json({ spot, side, bins });
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "invalid range" });
  }
}));

/// POST /yield/advanced — open an advanced position from the customer's box.
yieldRouter.post("/yield/advanced", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Advanced.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  try {
    res.json(await openForCustomer(account, { mode: "advanced", ...parsed.data }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    // Range and balance problems are the customer's to fix; anything else is ours.
    if (/range|price|box|amount/i.test(msg)) res.status(422).json({ error: msg });
    else throw err;
  }
}));

/// GET /yield/positions — open (and recently closed) positions, valued live.
yieldRouter.get("/yield/positions", requireSession("full"), asyncHandler(async (_req, res) => {
  const rows = await listPositions(res.locals.session.privyUserId, "all");
  const spot = await ethUsd();
  res.json({ spot, positions: await Promise.all(rows.map((r) => viewPosition(r, spot))) });
}));

/// POST /yield/positions/:id/close — dock it and return the value to the box.
yieldRouter.post("/yield/positions/:id/close", requireSession("full"), asyncHandler(async (req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const row = (await listPositions(account.privyUserId, "all")).find((p) => p.id === req.params.id);
  if (!row) {
    res.status(404).json({ error: "no such position" });
    return;
  }
  if (row.status !== "open") {
    res.status(409).json({ error: "position is already closed" });
    return;
  }
  // The ENS name is the deed: only its current holder can close the position.
  if (!(await holdsDeed(account, row.id))) {
    res.status(409).json({ error: "your wallet no longer holds this position's deed" });
    return;
  }
  res.json(await closeForCustomer(account, row));
}));
