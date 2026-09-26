import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { worldIdReady, type IdkitResult } from "../worldId.js";
import { loginWithWorld, worldLoginRequest } from "../worldLogin.js";

/// World ID login at the deposit terminal (see worldLogin.ts). No session
/// needed: the proof is what identifies the customer. Deposit-only, like /login/qr.
export const loginWorldRouter = Router();

/// GET /login/world/request — a signed World ID request bound to a one-time nonce.
loginWorldRouter.get("/login/world/request", asyncHandler(async (_req, res) => {
  if (!worldIdReady) {
    res.status(503).json({ error: "World ID login isn't available" });
    return;
  }
  res.json(await worldLoginRequest());
}));

const LoginWorldBody = z.object({
  nonce: z.string().min(1).max(128),
  result: z.object({ responses: z.array(z.unknown()) }).passthrough(),
});

/// POST /login/world { nonce, result } — the IDKit result from World App.
loginWorldRouter.post("/login/world", asyncHandler(async (req, res) => {
  const parsed = LoginWorldBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "World ID proof required" });
    return;
  }
  const outcome = await loginWithWorld(parsed.data.nonce, parsed.data.result as unknown as IdkitResult);
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }
  res.json(outcome.login);
}));
