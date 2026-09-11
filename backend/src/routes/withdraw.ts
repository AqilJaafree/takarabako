import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { store } from "../store.js";
import { proposeExitAll } from "../agent.js";

/// POST /withdraw — PRD §6.6. Exits every open position for the user,
/// settles USDC to the dev/treasury wallet (not the user's own address —
/// see PRD §6.6 and contracts/src/TakarabakoVault.sol `withdrawTo`), and
/// returns a redemption receipt with the 2% fee applied.
export const withdrawRouter = Router();

const WithdrawBody = z.object({
  nullifier: z.string().min(1),
});

withdrawRouter.post("/withdraw", async (req, res) => {
  const parsed = WithdrawBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { nullifier } = parsed.data;

  const user = store.getUser(nullifier);
  if (!user) {
    res.status(404).json({ error: "unknown user — complete /verify first" });
    return;
  }

  const positions = store.getPositions(nullifier);
  const { grossUsdc } = await proposeExitAll(positions);
  store.clearPositions(nullifier);

  const feeBps = config.withdrawFeeBps;
  const fee = (grossUsdc * feeBps) / 10_000;
  const netUsdc = grossUsdc - fee;

  store.logWithdraw({
    id: crypto.randomUUID(),
    nullifier,
    grossUsdc,
    feeBps,
    netUsdc,
    ts: Date.now(),
  });

  res.json({
    positionsClosed: positions.length,
    grossUsdc,
    feeBps,
    netUsdc,
    receipt: `$${grossUsdc.toFixed(2)} -> ${feeBps / 100}% fee -> $${netUsdc.toFixed(2)} ready for pickup`,
  });
});
