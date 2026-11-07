import { Router } from "express";
import { z } from "zod";
import { formatUnits, parseUnits } from "viem";
import { findByPrivyUserId } from "../accounts.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { requireSession } from "../sessions.js";
import { listSelf, prepareClose, prepareOpen, recordClose, recordOpen, pairBalances, walletState, withFees } from "../selfPositions.js";
import { dashOutQuote, prepareDashOut, type DashOutQuote } from "../dashOut.js";
import { selfNet } from "../selfChain.js";
import { ethCandles } from "../aqua.js";
import { eurcCandles } from "../pairPrice.js";
import { ADVANCED, allocate, baseAmount } from "../aquaMath.js";
import { selfBins } from "../selfShapes.js";
import { HybridBody, SELF_SHAPES, type SelfShape } from "../selfShapes.js";

/// Self-custody positions: the customer's own wallet signs. /self/arc/* is Arc mainnet (real money,
/// 404 unless SELF_CUSTODY_ARC=1) and /self/sepolia/* is the same flow on Sepolia with worthless
/// tokens (404 unless SELF_CUSTODY_SEPOLIA=1). See selfChain.ts and selfPositions.ts.
export const selfRouter = Router();

const hashes = z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(1).max(8);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/// A pair on the chain (see selfChain.ts); absent = the chain's default pair.
const pairKey = z.string().regex(/^[a-z0-9]{2,12}$/);
const Open = z.object({
  pair: pairKey.optional(),
  shape: z.enum(SELF_SHAPES as [SelfShape, ...SelfShape[]]),
  priceMin: z.number().positive().optional(),
  priceMax: z.number().positive().optional(),
  hybrid: HybridBody.optional(),
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
  const pair = pairKey.safeParse(req.query.pair);
  if (req.query.pair !== undefined && !pair.success) return void res.status(400).json({ error: "not a pair" });
  const net = selfNet(String(req.params.net), pair.success ? pair.data : undefined);
  // ?address= picks another wallet the customer connected (MetaMask, say); default is their Takarabako wallet.
  const asked = address.safeParse(req.query.address);
  if (req.query.address !== undefined && !asked.success) return void res.status(400).json({ error: "not a wallet address" });
  const owner = (asked.success ? asked.data : (await account(res)).privyWallet).toLowerCase();
  const [s, balances] = await Promise.all([walletState(net, owner), pairBalances(net, owner)]);
  res.json({
    pair: net.pairKey,
    /// The base token held in every pair on this chain, so each can offer its own Dash out.
    pairs: balances,
    address: s.address,
    usdc: Number(formatUnits(s.usdc, 6)),
    weth: baseAmount(s.weth, net.pair),
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
  res.json(await prepareOpen(selfNet(String(req.params.net), body.data.pair), await account(res), body.data));
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

// ---- dash out: sell the leftover base token for USDC through Aqua (dashOut.ts) -------------------

const DashOutBody = z.object({ pair: pairKey.optional(), wallet: address.optional(), amount: z.string().regex(/^\d+(\.\d+)?$/).optional() });

/// What the response says about a quote, in human units.
function dashOutView(net: ReturnType<typeof selfNet>, q: DashOutQuote) {
  const base = Number(net.pair.eth.decimals);
  const quote = Number(net.pair.usdc.decimals);
  return {
    pair: net.pairKey,
    symbols: net.symbols,
    balance: Number(formatUnits(q.balance, base)),
    amountIn: Number(formatUnits(q.amountIn, base)),
    amountOut: Number(formatUnits(q.amountOut, quote)),
    unfilled: Number(formatUnits(q.unfilled, base)),
    rate: q.rate,
    marketRate: q.marketRate,
    discountPct: q.discountPct,
    allowed: q.allowed,
    reason: q.reason,
    strategies: q.fills.length,
    maxDiscountPct: config.dashOut.maxDiscountPct,
  };
}

/// GET /self/:net/dashout?address=&amount= — what selling the wallet's leftover base token would get now.
selfRouter.get("/self/:net/dashout", requireSession("full"), asyncHandler(async (req, res) => {
  const pair = pairKey.safeParse(req.query.pair);
  if (req.query.pair !== undefined && !pair.success) return void res.status(400).json({ error: "not a pair" });
  const net = selfNet(String(req.params.net), pair.success ? pair.data : undefined);
  const asked = address.safeParse(req.query.address);
  if (req.query.address !== undefined && !asked.success) return void res.status(400).json({ error: "not a wallet address" });
  const wallet = (asked.success ? asked.data : (await account(res)).privyWallet).toLowerCase();
  const amount = typeof req.query.amount === "string" && /^\d+(\.\d+)?$/.test(req.query.amount) ? parseUnits(req.query.amount, Number(net.pair.eth.decimals)) : undefined;
  res.json(dashOutView(net, await dashOutQuote(net, wallet, amount)));
}));

/// POST /self/:net/dashout/prepare { wallet, amount } — the transactions to sign to sell it.
selfRouter.post("/self/:net/dashout/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const body = DashOutBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  const net = selfNet(String(req.params.net), body.data.pair);
  const wallet = (body.data.wallet ?? (await account(res)).privyWallet).toLowerCase();
  const amount = body.data.amount ? parseUnits(body.data.amount, Number(net.pair.eth.decimals)) : undefined;
  const { steps, quote, minOut } = await prepareDashOut(net, wallet, amount);
  res.json({ steps: await withFees(net, steps), quote: dashOutView(net, quote), minOut: Number(formatUnits(minOut, Number(net.pair.usdc.decimals))) });
}));

// ---- the market and the liquidity preview for one pair ------------------------------------------

/// GET /self/:net/market?pair= — the pair's checked price, the range limits, and a week of candles
/// where there is a price feed for them (without one, or if it has gone quiet, the
/// chart is drawn without candles).
selfRouter.get("/self/:net/market", requireSession("full"), asyncHandler(async (req, res) => {
  const pair = pairKey.safeParse(req.query.pair);
  if (req.query.pair !== undefined && !pair.success) return void res.status(400).json({ error: "not a pair" });
  const net = selfNet(String(req.params.net), pair.success ? pair.data : undefined);
  const spot = await net.spot();
  const candles = await (net.stable ? eurcCandles() : ethCandles()).catch(() => []);
  res.json({
    pair: net.pairKey,
    symbols: net.symbols,
    stable: net.stable,
    spot,
    candles,
    advanced: { minPrice: spot * ADVANCED.minFractionOfSpot, maxPrice: spot * ADVANCED.maxMultipleOfSpot, feeBps: net.feeBps ?? ADVANCED.feeBps, bins: ADVANCED.bins },
  });
}));

const PreviewBody = z.object({
  pair: pairKey.optional(),
  shape: z.enum(SELF_SHAPES as [SelfShape, ...SelfShape[]]),
  priceMin: z.number().positive().optional(),
  priceMax: z.number().positive().optional(),
  hybrid: HybridBody.optional(),
  amount: z.number().positive(),
});

/// POST /self/:net/preview { pair, shape, priceMin, priceMax, amount } — how the liquidity would split,
/// with the pair's own tokens and decimals (the yield page's preview is ETH-only).
selfRouter.post("/self/:net/preview", requireSession("full"), asyncHandler(async (req, res) => {
  const body = PreviewBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
  const net = selfNet(String(req.params.net), body.data.pair);
  const spot = await net.spot();
  try {
    const plan = selfBins(body.data.shape, spot, body.data.priceMin, body.data.priceMax, body.data.hybrid);
    const baseUnit = 10 ** Number(net.pair.eth.decimals);
    const quoteUnit = 10 ** Number(net.pair.usdc.decimals);
    const bins = plan.bins.map((b) => {
      const usd = body.data.amount * (b?.weight ?? 1);
      const { eth, usdc } = allocate(usd, b, spot, net.pair);
      return { min: b?.min ?? null, max: b?.max ?? null, weight: b?.weight ?? 1, usd, eth: Number(eth) / baseUnit, usdc: Number(usdc) / quoteUnit };
    });
    res.json({ spot, side: bins.every((b) => b.eth === 0) ? "usdc" : bins.every((b) => b.usdc === 0) ? "eth" : "both", bins });
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "invalid range" });
  }
}));
