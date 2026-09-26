import { Router } from "express";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { requestContext, verifyHuman, worldIdReady, type IdkitResult } from "../worldId.js";

/// World ID for the web app: a signed request for the IDKit widget, and the
/// endpoint the widget's proof is verified through.
export const worldIdRouter = Router();

/// GET /worldid/request — app id, action and a fresh RP-signed context, bound to this customer.
worldIdRouter.get("/worldid/request", requireSession("full"), asyncHandler(async (_req, res) => {
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
worldIdRouter.post("/me/worldid", requireSession("full"), asyncHandler(async (req, res) => {
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
