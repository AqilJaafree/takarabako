import { Router } from "express";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { z } from "zod";
import { config, isCashChain, type CashChainKey } from "../config.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { chainOps } from "../chain.js";
import { cashReceiptReadyOn, fromTkUnits, tkRead, toTkUnits } from "../cashReceipt.js";
import { confirmTkcashSend, ensureGas, lookup, sendBalance } from "../transfers.js";
import { allowanceJson, assertWithinLimit, dailyAllowance, DailyLimitError } from "../limits.js";

/// Sending between customers (web app) and the customer's own wallet. Customer-signed
/// transfers are prepared here (recipient resolved and checked, gas topped up) and the
/// browser has the customer sign the exact transaction in their own Privy wallet.
/// Every endpoint takes an optional `chain` (sepolia | arc-testnet); the default is the primary chain.
export const walletRouter = Router();

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

function chainParam(v: unknown): CashChainKey {
  const c = typeof v === "string" && v ? v : config.defaultChain;
  if (!isCashChain(c) || !config.enabledChains.includes(c)) throw Object.assign(new Error(`unknown or disabled chain "${c}"`), { status: 400 });
  return c;
}

/// GET /lookup?q=alice-1234&chain= — a label or wallet address to who it is.
walletRouter.get("/lookup", asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 3) {
    res.status(400).json({ error: "enter a label like alice-1234 or a wallet address" });
    return;
  }
  const r = await lookup(q, chainParam(req.query.chain));
  if (!r) {
    res.status(404).json({ error: `${q} isn't a label or wallet address we know` });
    return;
  }
  res.json(r);
}));

async function me(res: import("express").Response) {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return null;
  }
  return account;
}

/// GET /me/wallet — the customer's own wallet on each chain: gas, tkCASH and its transfer limits.
walletRouter.get("/me/wallet", requireSession("full"), asyncHandler(async (_req, res) => {
  const account = await me(res);
  if (!account) return;
  const today = Math.floor(Date.now() / 86_400_000);
  const chains = await Promise.all(
    config.enabledChains.map(async (key) => {
      const net = config.chains[key].network;
      const native = await chainOps(key).publicClient.getBalance({ address: account.privyWallet as Address }).then((w) => Number(w) / 1e18).catch(() => null);
      let tk: { balance: number; allowlisted: boolean; dailyLimit: number | null; spentToday: number } | null = null;
      if (cashReceiptReadyOn(key)) {
        const w = account.privyWallet;
        const [bal, allow, limit, spent, day] = await Promise.all([
          tkRead<string>(key, "balanceOf", [w]),
          tkRead<boolean>(key, "allowlist", [w]),
          tkRead<string>(key, "dailyTransferLimit"),
          tkRead<string>(key, "spentToday", [w]),
          tkRead<string>(key, "spentDay", [w]),
        ]).catch(() => [null, null, null, null, null] as const);
        if (bal !== null) {
          tk = {
            balance: fromTkUnits(bal),
            allowlisted: Boolean(allow),
            dailyLimit: BigInt(limit!) === 0n ? null : fromTkUnits(limit!),
            spentToday: Number(day) === today ? fromTkUnits(spent!) : 0,
          };
        }
      }
      return { chain: key, name: net.name, chainId: net.chain.id, nativeSymbol: net.nativeSymbol, native, tkcash: tk };
    }),
  );
  res.json({ label: account.label, wallet: account.privyWallet, chains, limit: allowanceJson(await dailyAllowance(account)) });
}));

const Send = z.object({ to: z.string().min(3), amount: z.number().positive(), chain: z.string().optional() });

/// POST /send/balance — box balance to another customer, by label or wallet address.
walletRouter.post("/send/balance", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Send.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await me(res);
  if (!account) return;
  try {
    const r = await sendBalance(account, parsed.data.to, parsed.data.amount, chainParam(parsed.data.chain));
    res.json({ to: r.to, txHash: r.txHash, amount: parsed.data.amount, chain: r.chain });
  } catch (err) {
    if (err instanceof DailyLimitError) throw err;
    res.status(422).json({ error: err instanceof Error ? err.message : "send failed" });
  }
}));

/// POST /send/tkcash/prepare — a tkCASH transfer for the customer to sign.
walletRouter.post("/send/tkcash/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Send.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const chain = chainParam(parsed.data.chain);
  const account = await me(res);
  if (!account) return;
  await assertWithinLimit(account, parsed.data.amount, "this tkCASH send");
  const target = await lookup(parsed.data.to, chain);
  if (!target) {
    res.status(422).json({ error: `${parsed.data.to} isn't a label or wallet address we know` });
    return;
  }
  if (target.tkcashAllowlisted === false) {
    res.status(422).json({ error: `${target.label ?? target.address} can't hold tkCASH, only registered Takarabako wallets can` });
    return;
  }
  const gas = await ensureGas(account, chain);
  res.json({
    recipient: target,
    gas,
    tx: {
      to: config.chains[chain].cashReceiptAddress,
      data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [target.address as Address, BigInt(toTkUnits(parsed.data.amount))] }),
      chainId: config.chains[chain].network.chain.id,
      // Arc drops transactions priced under its mempool floor without an error.
      ...(config.chains[chain].network.minMaxFeePerGas > 0n
        ? { maxFeePerGas: `0x${((config.chains[chain].network.minMaxFeePerGas * 5n) / 4n).toString(16)}`, maxPriorityFeePerGas: "0x0" }
        : {}),
    },
    from: account.privyWallet,
    chain,
  });
}));

/// POST /send/tkcash/confirm { txHash, to, chain } — record a signed tkCASH transfer.
walletRouter.post("/send/tkcash/confirm", requireSession("full"), asyncHandler(async (req, res) => {
  const account = await me(res);
  if (!account) return;
  const txHash = String(req.body?.txHash ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    res.status(400).json({ error: "txHash required" });
    return;
  }
  try {
    res.json(await confirmTkcashSend(account, txHash, chainParam(req.body?.chain), typeof req.body?.to === "string" ? req.body.to : null));
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "couldn't confirm" });
  }
}));
