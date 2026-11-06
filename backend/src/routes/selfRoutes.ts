import { Router } from "express";
import { z } from "zod";
import { formatUnits } from "viem";
import { findByPrivyUserId } from "../accounts.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { requireSession } from "../sessions.js";
import { listSelf, prepareClose, prepareOpen, recordClose, recordOpen, walletState } from "../selfPositions.js";

/// Self-custody positions on Arc mainnet: the customer's own wallet signs. Real
/// money, so every route answers 404 unless SELF_CUSTODY_ARC=1 (selfPositions.ts).
export const selfRouter = Router();

const hashes = z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(1).max(8);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Open = z.object({ mode: z.enum(["low", "medium", "high", "hybrid"]), amount: z.number().positive(), wallet: address.optional() });
const Record = z.object({ positionId: z.string().uuid(), txHashes: hashes });
const RecordClose = z.object({ txHashes: hashes });

async function account(res: import("express").Response) {
  const a = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!a) throw Object.assign(new Error("unknown account"), { status: 404 });
  return a;
}

/// GET /self/arc/wallet — what the customer's wallet holds on Arc.
selfRouter.get("/self/arc/wallet", requireSession("full"), asyncHandler(async (req, res) => {
  // ?address= picks another wallet the customer connected (MetaMask, say); default is their Takarabako wallet.
  const asked = address.safeParse(req.query.address);
  if (req.query.address !== undefined && !asked.success) return void res.status(400).json({ error: "not a wallet address" });
  const s = await walletState((asked.success ? asked.data : (await account(res)).privyWallet).toLowerCase());
  res.json({
    address: s.address,
    usdc: Number(formatUnits(s.usdc, 6)),
    weth: Number(formatUnits(s.weth, 18)),
    gasUsdc: Number(formatUnits(s.gasUsdc, 6)),
    maxUsd: config.selfCustody.maxUsd,
  });
}));

/// POST /self/arc/prepare { mode, amount } — the transactions to sign to open a position.
selfRouter.post("/self/arc/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const body = Open.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  res.json(await prepareOpen(await account(res), body.data));
}));

/// POST /self/arc/record { positionId, txHashes } — after signing: checks them on chain and opens the position.
selfRouter.post("/self/arc/record", requireSession("full"), asyncHandler(async (req, res) => {
  const body = Record.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  res.json(await recordOpen(await account(res), body.data.positionId, body.data.txHashes));
}));

/// GET /self/arc/positions — the customer's self-custody positions, valued live.
selfRouter.get("/self/arc/positions", requireSession("full"), asyncHandler(async (_req, res) => {
  res.json({ positions: await listSelf(res.locals.session.privyUserId) });
}));

selfRouter.post("/self/arc/positions/:id/close/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  res.json(await prepareClose(await account(res), String(req.params.id)));
}));

selfRouter.post("/self/arc/positions/:id/close/record", requireSession("full"), asyncHandler(async (req, res) => {
  const body = RecordClose.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  res.json(await recordClose(await account(res), String(req.params.id), body.data.txHashes));
}));
