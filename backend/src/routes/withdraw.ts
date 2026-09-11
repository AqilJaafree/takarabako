import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { store } from "../store.js";
import { proposeExitAll } from "../agent.js";

/// POST /withdraw — PRD §6.6. Exits every open position for the user,
/// settles JPYC to the dev/treasury wallet (not the user's own address —
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
  const { grossJpyc } = await proposeExitAll(positions);
  store.clearPositions(nullifier);

  const feeBps = config.withdrawFeeBps;
  const fee = (grossJpyc * feeBps) / 10_000;
  const netJpyc = grossJpyc - fee;

  store.logWithdraw({
    id: crypto.randomUUID(),
    nullifier,
    grossJpyc,
    feeBps,
    netJpyc,
    ts: Date.now(),
  });

  res.json({
    positionsClosed: positions.length,
    grossJpyc,
    feeBps,
    netJpyc,
    receipt: `¥${grossJpyc.toFixed(0)} -> ${feeBps / 100}% fee -> ¥${netJpyc.toFixed(0)} ready for pickup`,
  });
});
