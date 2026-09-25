import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { store } from "../store.js";
import { chainReady, depositOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";
import { toUsd, usdPerUnit } from "../fx.js";

/// POST /deposit — PRD §6.2 (ATM-style: comes after /verify now). Cash
/// lands in the box, backend fronts USDC from the treasury via a real
/// on-chain `depositFor` call into the account's already-known
/// `boundAddress` (established at /verify time — see contracts/src/TakarabakoVault.sol,
/// wired up in chain.ts).
export const depositRouter = Router();

const DepositBody = z.object({
  userId: z.string().min(1),
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

depositRouter.post("/deposit", asyncHandler(async (req, res) => {
  const parsed = DepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { userId, amount, currency } = parsed.data;

  const account = store.getAccount(userId);
  if (!account) {
    res.status(404).json({ error: "unknown account — complete /verify first" });
    return;
  }
  if (!chainReady) {
    res.status(503).json({ error: "chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS in backend/.env" });
    return;
  }

  const { usdAmount, rate, source } = await toUsd(amount, currency);
  if (currency !== "USD") console.log(`[fx] ${currency} ${amount} -> USD ${usdAmount} at ${rate} (${source})`);

  const { txHash, value } = await depositOnChain(account.boundAddress as Address, usdAmount);
  account.idleBalance = value;

  store.logDeposit({
    id: crypto.randomUUID(),
    privyUserId: userId,
    denomination: amount,
    currency,
    usdAmount,
    txHash,
    ts: Date.now(),
  });

  res.json({
    ensName: account.ensName,
    boundAddress: account.boundAddress,
    balance: account.idleBalance,
    txHash,
    currency,
    usdAmount,
    fxRate: rate,
    fxSource: source,
  });
}));
