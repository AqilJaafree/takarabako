import { Router } from "express";
import { z } from "zod";
import { findByPrivyUserId, createQueuedDeposit, markDepositFailed } from "../accounts.js";
import { requireSession, type Session } from "../sessions.js";
import { chainOps, readyChains } from "../chain.js";
import { getKiosk } from "../kiosks.js";
import { config } from "../config.js";
import { resolveDepositChain } from "../depositChain.js";
import { enqueueDeposit } from "../depositQueue.js";
import { publishUserEvent } from "../events.js";
import { currentOpenSession } from "../history.js";
import { asyncHandler } from "../asyncHandler.js";
import { checkMachine, machineSignatureRequired } from "../machine.js";
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
  // The kiosk's signature over this note (device-agent/machine.js).
  machine: z
    .object({
      kiosk: z.string(),
      amount: z.string(),
      currency: z.string(),
      nonce: z.string(),
      issuedAt: z.string(),
      signature: z.string(),
      device: z.string().optional(),
    })
    .optional(),
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

  // Which machine took this note, proven by its signature and the kiosk's registered key.
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const machine = await checkMachine(parsed.data.machine, { amount, currency, token });
  if (!machine.verified && parsed.data.machine) console.warn(`[machine] unverified note from ${machine.kiosk ?? "?"}: ${machine.reason}`);
  if (!machine.verified && machineSignatureRequired()) {
    res.status(403).json({ error: `deposit not signed by a registered Takarabako kiosk (${machine.reason})` });
    return;
  }

  // The note is credited on the network the customer picked, else its kiosk's home chain (the
  // registered kiosk that signed it, else the backend's own kiosk), else the primary chain.
  const homeKiosk = machine.verified ? null : await getKiosk(config.kioskId);
  const kioskChain = machine.verified ? machine.chain : homeKiosk?.chain;
  const chain = resolveDepositChain({ customer: account.depositChain, kiosk: kioskChain, ready: readyChains(), fallback: config.defaultChain });
  if (account.depositChain && account.depositChain !== chain) {
    console.warn(`[deposit] ${account.depositChain} isn't available, crediting ${account.privyUserId} on ${chain}`);
  }
  if (!chainOps(chain).chainReady) {
    res.status(503).json({ error: `${config.chains[chain].network.name} isn't configured: set the treasury key and the USDC and vault addresses in backend/.env` });
    return;
  }

  const open = await currentOpenSession(account.privyUserId);
  const row = await createQueuedDeposit({
    chain,
    privyUserId: account.privyUserId,
    currency,
    amount,
    sessionId: open?.id ?? null,
    machine: machine.verified ? { name: machine.kiosk, signer: machine.signer, nonce: machine.nonce, signature: machine.signature } : null,
  });
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
    sessionId: row.sessionId,
    machine: machine.verified ? { kiosk: machine.kiosk, verified: true } : { verified: false, reason: machine.reason },
    label: account.label,
    chain,
    amount,
    currency,
    estUsd,
    expiresAt: session.expiresAt,
  });
}));
