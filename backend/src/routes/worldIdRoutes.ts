import { Router } from "express";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { requestContext, verifyHuman, worldIdReady, type IdkitResult } from "../worldId.js";

/// World ID at the kiosk: after a customer logs in at the deposit terminal
/// (a deposit-scope session is enough), the kiosk shows World ID's QR and the
/// customer approves it in World App on their phone. These give the kiosk a
/// signed request and verify the proof that comes back.
export const worldIdRouter = Router();

/// GET /worldid/request — app id, action and a fresh RP-signed context, bound to this customer.
worldIdRouter.get("/worldid/request", requireSession("deposit"), asyncHandler(async (_req, res) => {
  if (!worldIdReady) {
    res.status(503).json({ error: "World ID is not configured" });
    return;
  }
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  res.json({ ...requestContext(account), verified: Boolean(account.worldVerifiedAt) });
}));

/// POST /me/worldid — the IDKit result; verified with World and recorded.
worldIdRouter.post("/me/worldid", requireSession("deposit"), asyncHandler(async (req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const outcome = await verifyHuman(account, req.body as IdkitResult);
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }
  res.json({ verified: true, credential: outcome.credential, alreadyVerified: outcome.alreadyVerified });
}));
