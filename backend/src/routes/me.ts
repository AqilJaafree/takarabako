import { Router } from "express";
import type { Address } from "viem";
import QRCode from "qrcode";
import { findByPrivyUserId, listDeposits } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { store } from "../store.js";
import { chainReady, previewValueOnChain, currentApyBpsOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";

/// Read endpoints for the web app (full sessions only): the account at a
/// glance, deposit history, and the quick-deposit QR to show at the kiosk.
export const meRouter = Router();

meRouter.get("/me", requireSession("full"), asyncHandler(async (_req, res) => {
  const userId: string = res.locals.session.privyUserId;
  const account = await findByPrivyUserId(userId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const [balance, apyBps] = chainReady
    ? await Promise.all([previewValueOnChain(account.boundAddress as Address), currentApyBpsOnChain()])
    : [0, 0];
  res.json({
    userId,
    ensName: account.ensName,
    privyWallet: account.privyWallet,
    balance,
    apyBps,
    positions: store.getPositions(userId),
    expiresAt: res.locals.session.expiresAt,
  });
}));

meRouter.get("/deposits", requireSession("full"), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  res.json({ deposits: await listDeposits(res.locals.session.privyUserId, limit) });
}));

meRouter.get("/me/qr", requireSession("full"), asyncHandler(async (_req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  res.json({
    wallet: account.privyWallet,
    dataUrl: await QRCode.toDataURL(account.privyWallet, { width: 480, margin: 2 }),
  });
}));
