import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { findByWallet } from "../accounts.js";
import { createSession, endSession, requireSession } from "../sessions.js";
import { parseWalletFromQr } from "../qr.js";
import { chainReady, previewValueOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";
import { allowanceJson, dailyAllowance } from "../limits.js";

/// POST /login/qr — quick login for returning customers: the kiosk camera
/// reads their Privy wallet QR and they get a deposit-only session.
export const loginQrRouter = Router();

const LoginQrBody = z.object({ qr: z.string().min(1).max(512) });

loginQrRouter.post("/login/qr", asyncHandler(async (req, res) => {
  const parsed = LoginQrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "qr text required" });
    return;
  }
  const wallet = parseWalletFromQr(parsed.data.qr);
  if (!wallet) {
    res.status(400).json({ error: "That's not a Takarabako QR" });
    return;
  }
  const account = await findByWallet(wallet);
  if (!account) {
    res.status(404).json({ error: "This QR isn't registered. Sign up with your email first." });
    return;
  }

  const session = await createSession(account.privyUserId, "deposit");
  const balance = chainReady ? await previewValueOnChain(account.boundAddress as Address) : 0;
  res.json({
    userId: account.privyUserId,
    ensName: account.ensName,
    balance,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    worldVerified: Boolean(account.worldVerifiedAt),
    limit: allowanceJson(await dailyAllowance(account)), // the deposit terminal shows what's left today
  });
}));

/// POST /logout — ends the session (either scope) when the customer taps Done.
loginQrRouter.post("/logout", requireSession("deposit"), asyncHandler(async (_req, res) => {
  await endSession(res.locals.session.token);
  res.json({ ok: true });
}));
