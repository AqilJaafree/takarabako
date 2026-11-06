import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { chainOps } from "../chain.js";
import { assertWithinLimit } from "../limits.js";
import { advanceTransfer, BridgeError, createTransfer, getTransfer, listTransfers, validateAmount, validateRoute } from "../bridge.js";
import { estimateMinutes } from "../cctp.js";
import type { Address } from "viem";

/// Moving a customer's USDC between chains (bridge.ts, Circle CCTP V2).
/// Full sessions only: it moves money out of the box.
export const bridgeRouter = Router();

const Body = z.object({ from: z.string(), to: z.string(), amount: z.number().positive() });

async function me(res: import("express").Response) {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return null;
  }
  return account;
}

const publicView = (t: Awaited<ReturnType<typeof getTransfer>> & object) => ({
  id: t!.id,
  kind: t!.kind,
  fromChain: t!.fromChain,
  toChain: t!.toChain,
  amountUsd: t!.amountUsd,
  state: t!.state,
  withdrawTx: t!.withdrawTx,
  burnTx: t!.burnTx,
  mintTx: t!.mintTx,
  creditTx: t!.creditTx,
  error: t!.state === "failed" ? t!.error : null,
  createdAt: t!.createdAt,
  updatedAt: t!.updatedAt,
  explorers: {
    from: config.chains[t!.fromChain].network.explorerUrl,
    to: config.chains[t!.toChain].network.explorerUrl,
  },
});

/// POST /bridge/quote { from, to, amount } — what the transfer would do, and whether the box can cover it.
bridgeRouter.post("/bridge/quote", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await me(res);
  if (!account) return;
  const route = validateRoute(parsed.data.from, parsed.data.to);
  validateAmount(parsed.data.amount);
  const available = await chainOps(route.from).previewValueOnChain(account.boundAddress as Address).catch(() => 0);
  res.json({
    from: route.from,
    to: route.to,
    amount: parsed.data.amount,
    feeUsd: 0, // standard CCTP transfer
    receiveUsd: parsed.data.amount,
    availableOnSource: available,
    enough: available + 1e-9 >= parsed.data.amount,
    estimatedMinutes: estimateMinutes(route.from),
    maxUsd: config.bridge.maxUsd,
  });
}));

/// POST /bridge { from, to, amount } — start a transfer. Answers 202 at once; the transfer
/// then runs in the background and reports progress on GET /bridge/:id and the live stream.
bridgeRouter.post("/bridge", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await me(res);
  if (!account) return;
  const route = validateRoute(parsed.data.from, parsed.data.to);
  validateAmount(parsed.data.amount);
  await assertWithinLimit(account, parsed.data.amount, "this transfer");
  const available = await chainOps(route.from).previewValueOnChain(account.boundAddress as Address);
  if (available + 1e-9 < parsed.data.amount) throw new BridgeError(`you have $${available.toFixed(2)} on ${config.chains[route.from].network.name}`);

  const transfer = await createTransfer({
    privyUserId: account.privyUserId,
    kind: "customer",
    from: route.from,
    to: route.to,
    amountUsd: parsed.data.amount,
    recipient: account.boundAddress,
  });
  void advanceTransfer(transfer.id).catch((err) => console.error("[bridge] advance:", err instanceof Error ? err.message : err));
  res.status(202).json({ ...publicView(transfer), estimatedMinutes: estimateMinutes(route.from) });
}));

/// GET /bridge — the customer's recent transfers.
bridgeRouter.get("/bridge", requireSession("full"), asyncHandler(async (_req, res) => {
  const rows = await listTransfers({ privyUserId: res.locals.session.privyUserId, limit: 20 });
  res.json({ transfers: rows.map(publicView) });
}));

/// GET /bridge/:id — one transfer's progress.
bridgeRouter.get("/bridge/:id", requireSession("full"), asyncHandler(async (req, res) => {
  const t = await getTransfer(String(req.params.id));
  if (!t || t.privyUserId !== res.locals.session.privyUserId) {
    res.status(404).json({ error: "transfer not found" });
    return;
  }
  res.json(publicView(t));
}));
