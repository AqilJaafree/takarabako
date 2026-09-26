import { Router } from "express";
import { z } from "zod";
import { findByWallet } from "../accounts.js";
import { endSession, requireSession } from "../sessions.js";
import { parseWalletFromQr } from "../qr.js";
import { asyncHandler } from "../asyncHandler.js";
import { depositLogin } from "../depositLogin.js";
import { accountForDepositQr, isDepositQr } from "../depositCode.js";

/// POST /login/qr — quick login for returning customers: the kiosk camera
/// reads their QR and they get a deposit-only session. Takes the rotating
/// deposit QR from the web app's Deposit tab (depositCode.ts, 5 minutes), or
/// the account's wallet address (the QR in the welcome email).
export const loginQrRouter = Router();

const LoginQrBody = z.object({ qr: z.string().min(1).max(512) });

loginQrRouter.post("/login/qr", asyncHandler(async (req, res) => {
  const parsed = LoginQrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "qr text required" });
    return;
  }
  if (isDepositQr(parsed.data.qr)) {
    const found = await accountForDepositQr(parsed.data.qr);
    if (!found.ok) {
      res.status(found.status).json({ error: found.error });
      return;
    }
    res.json(await depositLogin(found.account));
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

  res.json(await depositLogin(account));
}));

/// POST /logout — ends the session (either scope) when the customer taps Done.
loginQrRouter.post("/logout", requireSession("deposit"), asyncHandler(async (_req, res) => {
  await endSession(res.locals.session.token);
  res.json({ ok: true });
}));
