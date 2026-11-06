import { Router } from "express";
import { z } from "zod";
import { formatUnits } from "viem";
import { findByPrivyUserId } from "../accounts.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { requireSession } from "../sessions.js";
import { listSelf, prepareClose, prepareOpen, recordClose, recordOpen, walletState } from "../selfPositions.js";
import { selfNet } from "../selfChain.js";
import { SELF_SHAPES, type SelfShape } from "../selfShapes.js";

/// Self-custody positions: the customer's own wallet signs. /self/arc/* is Arc mainnet (real money,
/// 404 unless SELF_CUSTODY_ARC=1) and /self/sepolia/* is the same flow on Sepolia with worthless
/// tokens (404 unless SELF_CUSTODY_SEPOLIA=1). See selfChain.ts and selfPositions.ts.
export const selfRouter = Router();

const hashes = z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(1).max(8);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Open = z.object({
  shape: z.enum(SELF_SHAPES as [SelfShape, ...SelfShape[]]),
  priceMin: z.number().positive().optional(),
  priceMax: z.number().positive().optional(),
  amount: z.number().positive(),
  wallet: address.optional(),
});
const Record = z.object({ positionId: z.string().uuid(), txHashes: hashes });
const RecordClose = z.object({ txHashes: hashes });

async function account(res: import("express").Response) {
  const a = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!a) throw Object.assign(new Error("unknown account"), { status: 404 });
  return a;
}

/// GET /self/:net/wallet — what the customer's wallet holds on Arc.
selfRouter.get("/self/:net/wallet", requireSession("full"), asyncHandler(async (req, res) => {
  const net = selfNet(String(req.params.net));
  // ?address= picks another wallet the customer connected (MetaMask, say); default is their Takarabako wallet.
  const asked = address.safeParse(req.query.address);
  if (req.query.address !== undefined && !asked.success) return void res.status(400).json({ error: "not a wallet address" });
  const s = await walletState(net, (asked.success ? asked.data : (await account(res)).privyWallet).toLowerCase());
  res.json({
    address: s.address,
    usdc: Number(formatUnits(s.usdc, 6)),
    weth: Number(formatUnits(s.weth, 18)),
    /// The native coin for network fees, and its name on this chain (USDC on Arc, ETH on Sepolia).
    gas: Number(formatUnits(s.gasNative, 18)),
    gasSymbol: net.symbols.gas,
    gasUsdc: Number(formatUnits(s.gasNative, 18)),
    symbols: net.symbols,
    /// "contract": a position manager holds the tokens while it is open; "wallet": they stay in the wallet.
    custody: net.manager ? "contract" : "wallet",
    maxUsd: config.selfCustody.maxUsd,
  });
}));

/// POST /self/:net/prepare { shape, priceMin, priceMax, amount } — the transactions to sign to open a position.
selfRouter.post("/self/:net/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const body = Open.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  res.json(await prepareOpen(selfNet(String(req.params.net)), await account(res), body.data));
}));

/// POST /self/:net/record { positionId, txHashes } — after signing: checks them on chain and opens the position.
selfRouter.post("/self/:net/record", requireSession("full"), asyncHandler(async (req, res) => {
  const body = Record.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  res.json(await recordOpen(selfNet(String(req.params.net)), await account(res), body.data.positionId, body.data.txHashes));
}));

/// GET /self/:net/positions — the customer's self-custody positions, valued live.
selfRouter.get("/self/:net/positions", requireSession("full"), asyncHandler(async (req, res) => {
  res.json({ positions: await listSelf(selfNet(String(req.params.net)), res.locals.session.privyUserId) });
}));

selfRouter.post("/self/:net/positions/:id/close/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  res.json(await prepareClose(selfNet(String(req.params.net)), await account(res), String(req.params.id)));
}));

selfRouter.post("/self/:net/positions/:id/close/record", requireSession("full"), asyncHandler(async (req, res) => {
  const body = RecordClose.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  res.json(await recordClose(selfNet(String(req.params.net)), await account(res), String(req.params.id), body.data.txHashes));
}));
