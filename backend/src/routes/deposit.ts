import { Router } from "express";
import { z } from "zod";
import { findByPrivyUserId, createQueuedDeposit, markDepositFailed } from "../accounts.js";
import { requireSession, type Session } from "../sessions.js";
import { chainReady } from "../chain.js";
import { enqueueDeposit } from "../depositQueue.js";
import { publishUserEvent } from "../events.js";
import { asyncHandler } from "../asyncHandler.js";
import { toUsd, usdPerUnit } from "../fx.js";

/// POST /deposit — PRD §6.2 (ATM-style: comes after login). Cash lands in the
/// box; the backend records a queued deposit and answers at once (202). The
/// deposit queue (depositQueue.ts) fronts USDC from the treasury into the
/// account's vault `boundAddress` via `depositFor`, retrying on failure, and
/// publishes pending → confirmed | retrying | failed on the user's live stream.
export const depositRouter = Router();

const DepositBody = z.object({
  amount: z.number().positive(),
  // Currency of the cash inserted. The bill acceptor sends MYR; the vault is
  // credited in USD(C) after conversion.
  currency: z.enum(["USD", "MYR"]).default("USD"),
});

/// GET /fx?currency=MYR — the rate /deposit will use, so the kiosk can show
/// an estimated USD amount the moment a note is stacked, before the deposit
/// transaction is mined.
depositRouter.get("/fx", asyncHandler(async (req, res) => {
  const currency = req.query.currency === "MYR" ? "MYR" : "USD";
  res.json({ currency, ...(await usdPerUnit(currency)) });
}));

// Any live session may deposit: email login (full) or wallet-QR login
// (deposit). The account comes from the session, never the request body.
depositRouter.post("/deposit", requireSession("deposit"), asyncHandler(async (req, res) => {
  const parsed = DepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { amount, currency } = parsed.data;
  const session: Session = res.locals.session;

  const account = await findByPrivyUserId(session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  if (!chainReady) {
    res.status(503).json({ error: "chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS in backend/.env" });
    return;
  }

  const row = await createQueuedDeposit({ privyUserId: account.privyUserId, currency, amount });
  // The rate is cached (fx.ts), so this estimate is instant; the credited
  // amount is fixed when the queue sends the transaction.
  const { usdAmount: estUsd } = await toUsd(amount, currency);

  try {
    await enqueueDeposit(row.id);
  } catch (err) {
    // Redis down. The note is already stacked by the time we get here, so
    // keep the row (status failed) in Postgres: it's the record of cash
    // received and can be re-queued once Redis is back.
    await markDepositFailed(row.id, "queue unavailable", true);
    console.error("[deposit] could not enqueue:", err);
    res.status(503).json({ error: "deposits are temporarily unavailable" });
    return;
  }
  await publishUserEvent(account.privyUserId, { type: "deposit.pending", depositId: row.id, amount, currency, estUsd });

  res.status(202).json({
    depositId: row.id,
    ensName: account.ensName,
    amount,
    currency,
    estUsd,
    expiresAt: session.expiresAt,
  });
}));
