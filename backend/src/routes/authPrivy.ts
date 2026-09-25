import { Router } from "express";
import { z } from "zod";
import { InvalidAuthTokenError } from "@privy-io/node";
import { userFromAccessToken } from "../privy.js";
import { loginFull } from "../accountsFlow.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /auth/privy — the web app's login. The browser logs in with a Privy
/// email code; the Next.js server sends Privy's access token here. We verify
/// it against Privy's keys (never trusting a typed email) and return a full
/// session for the same account the kiosk uses.
export const authPrivyRouter = Router();

const AuthBody = z.object({ accessToken: z.string().min(1) });

authPrivyRouter.post("/auth/privy", asyncHandler(async (req, res) => {
  const parsed = AuthBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "accessToken required" });
    return;
  }

  let user;
  try {
    user = await userFromAccessToken(parsed.data.accessToken);
  } catch (err) {
    if (err instanceof InvalidAuthTokenError || (err instanceof Error && /jwt|jws|token/i.test(err.message))) {
      res.status(401).json({ error: "Privy login is invalid or expired — log in again" });
      return;
    }
    throw err;
  }

  const result = await loginFull({ privyUserId: user.userId, email: user.email, walletAddress: user.walletAddress });
  res.json({ ...result, fundingTxHash: user.fundingTxHash });
}));
