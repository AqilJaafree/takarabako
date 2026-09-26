import { Router } from "express";
import { z } from "zod";
import { getOrCreateUserWallet } from "../privy.js";
import { loginFull } from "../accountsFlow.js";
import { findByEmail } from "../accounts.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /verify — PRD §6.1 (ATM-style: identity first, cash second). Takes
/// an email on the kiosk screen, resolves (or creates) that person's real
/// Privy user + embedded wallet server-side, and — for a brand-new
/// account — registers their ENS v2 subname right here, before any cash
/// has been inserted. This is the sybil gate for the whole system (PRD
/// §10): like a real ATM, you identify yourself before the machine knows
/// which account to credit, rather than depositing blind and hoping the
/// right person claims it afterward.
export const verifyRouter = Router();

const VerifyBody = z.object({
  email: z.string().email(),
});

verifyRouter.post("/verify", asyncHandler(async (req, res) => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { email } = parsed.data;

  // Someone already registered (by email code or Google, at the kiosk or on
  // the web) is found by email in Postgres first. Privy's email lookup
  // doesn't see Google sign-ups, so without this a Google user typing their
  // email here would get a second, separate account.
  const known = await findByEmail(email);
  if (known) {
    res.json(await loginFull({ privyUserId: known.privyUserId, email: known.email, walletAddress: known.privyWallet }));
    return;
  }

  const { userId, walletAddress, fundingTxHash } = await getOrCreateUserWallet(email);

  res.json({ ...(await loginFull({ privyUserId: userId, email, walletAddress })), fundingTxHash });
}));
