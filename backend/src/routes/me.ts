import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { findByPrivyUserId, listDeposits, setDepositChain, type Account } from "../accounts.js";
import { chainOps, readyChains } from "../chain.js";
import { resolveDepositChain } from "../depositChain.js";
import { getKiosk } from "../kiosks.js";
import { requireSession } from "../sessions.js";
import { positionSummaries } from "../yieldPositions.js";
import { balancesByChain, totalOf } from "../balances.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { allowanceJson, dailyAllowance } from "../limits.js";
import { allowlist, cashReceiptReadyOn, fromTkUnits, kioskState, tkRead, tkSupply } from "../cashReceipt.js";
import { isCashChain, type CashChainKey } from "../config.js";
import { issueDepositCode } from "../depositCode.js";

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
  const balances = await balancesByChain(account.boundAddress);
  const balance = totalOf(balances);
  const apyBps = balances.find((b) => b.chain === config.defaultChain)?.apyBps ?? balances[0]?.apyBps ?? 0;
  res.json({
    userId,
    label: account.label,
    privyWallet: account.privyWallet,
    balance,
    balances,
    apyBps,
    positions: await positionSummaries(userId).catch(() => []),
    limit: allowanceJson(await dailyAllowance(account)),
    expiresAt: res.locals.session.expiresAt,
  });
}));

/// Where this customer's next note would be credited, and the chains they can pick from.
async function depositChainInfo(account: Account) {
  const ready = readyChains();
  const kiosk = await getKiosk(config.kioskId);
  return {
    chain: resolveDepositChain({ customer: account.depositChain, kiosk: kiosk?.chain, ready, fallback: config.defaultChain }),
    chosen: account.depositChain,
    options: ready,
  };
}

// A kiosk's deposit-only session may read this, to show where the notes are going. Only a full
// session can change it (below).
meRouter.get("/me/deposit-chain", requireSession("deposit"), asyncHandler(async (req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const info = await depositChainInfo(account);
  // ?balance=1: the box on that chain, which is a chain read, so only the kiosk asks for it.
  if (req.query.balance !== "1") {
    res.json(info);
    return;
  }
  const balance = await chainOps(info.chain).previewValueOnChain(account.boundAddress as `0x${string}`).catch(() => null);
  res.json({ ...info, balance });
}));

const DepositChainBody = z.object({ chain: z.string() });

/// POST /me/deposit-chain { chain } — the customer picks the network their notes are credited and
/// their tkCASH minted on. Only a chain that can take a deposit right now can be picked.
meRouter.post("/me/deposit-chain", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = DepositChainBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const chain = readyChains().find((key) => key === parsed.data.chain);
  if (!chain) {
    res.status(422).json({ error: `${parsed.data.chain} can't take deposits right now`, ...(await depositChainInfo(account)) });
    return;
  }
  await setDepositChain(account.privyUserId, chain);
  // Minting doesn't need the allowlist, but sending tkCASH on this chain later does. A customer who
  // registered before this chain was enabled isn't on it yet. In the background: picking never waits.
  void (async () => {
    if (!cashReceiptReadyOn(chain)) return;
    if (!(await tkRead<boolean>(chain, "allowlist", [account.privyWallet]))) await allowlist(account.privyWallet, chain);
  })().catch((err) => console.error(`[tkcash] allowlist on ${chain}:`, err instanceof Error ? err.message : err));
  res.json(await depositChainInfo({ ...account, depositChain: chain }));
}));

meRouter.get("/deposits", requireSession("full"), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  res.json({ deposits: await listDeposits(res.locals.session.privyUserId, limit) });
}));

/// GET /me/qr — a fresh deposit QR (depositCode.ts): valid for 5 minutes,
/// and it replaces the account's previous one. Every call issues a new code.
meRouter.get("/me/qr", requireSession("full"), asyncHandler(async (_req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const { qr, expiresAt, ttlSeconds } = await issueDepositCode(account.privyUserId);
  res.set("cache-control", "no-store");
  res.json({
    wallet: account.privyWallet,
    qr,
    expiresAt,
    ttlSeconds,
    dataUrl: await QRCode.toDataURL(qr, { width: 480, margin: 2 }),
  });
}));

/// GET /me/cash-receipts?chain= — the customer's tkCASH on one chain: their balance (a
/// claim on banknotes in the kiosk's box) and the proof that it's backed. Without
/// `chain`, every enabled chain is returned under `chains`.
meRouter.get("/me/cash-receipts", requireSession("full"), asyncHandler(async (req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const one = async (chain: CashChainKey) => {
    if (!cashReceiptReadyOn(chain)) return { chain, configured: false as const };
    const [balance, kiosk, supply] = await Promise.all([
      tkRead<string>(chain, "balanceOf", [account.privyWallet]),
      kioskState(config.kioskId, chain),
      tkSupply(chain),
    ]);
    return {
      chain,
      configured: true as const,
      contract: config.chains[chain].cashReceiptAddress,
      wallet: account.privyWallet,
      balance: fromTkUnits(balance),
      kiosk: { kioskId: kiosk.kioskId, reserve: kiosk.reserve, active: kiosk.active, frozen: kiosk.frozen, lastAuditAt: kiosk.lastAuditAt },
      supply: supply.supply,
      reserve: supply.reserve,
      backed: Math.abs(supply.supply - supply.reserve) < 1e-6,
    };
  };
  const wanted = typeof req.query.chain === "string" ? req.query.chain : null;
  if (wanted) {
    if (!isCashChain(wanted)) {
      res.status(400).json({ error: `unknown chain "${wanted}"` });
      return;
    }
    res.json(await one(wanted));
    return;
  }
  // One chain's RPC having a bad moment must not hide the customer's tkCASH on the others.
  const chains = await Promise.all(
    config.enabledChains.map((chain) =>
      one(chain).catch((err) => {
        console.error(`[tkcash] reading ${chain}:`, err instanceof Error ? err.message.split("\n")[0] : err);
        return { chain, configured: false as const, unavailable: true as const };
      }),
    ),
  );
  const primary = chains.find((c) => c.chain === config.defaultChain) ?? chains[0];
  res.json({ ...primary, chains, totalBalance: chains.reduce((s, c) => s + (c.configured ? c.balance : 0), 0) });
}));
