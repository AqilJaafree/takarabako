import { decodeFunctionResult, encodeFunctionData, maxUint256, parseAbi, type Address } from "viem";
import { config } from "./config.js";
import { sv } from "./aquaSdk.js";
import { ethUsd, openPositions, PAIR, strategyBalances } from "./aqua.js";
import { publicClient, sendTreasuryTx, sendTreasuryTxNoWait, treasuryAddress, waitForTx } from "./chain.js";

/// A tiny market maker for the demo. On mainnet, arbitrage traders keep Aqua
/// strategies priced at the market and pay them fees; on Sepolia nobody
/// trades, so positions would never earn or move through their ranges. This
/// trades against our own strategies (treasury as taker), pushing each one's
/// price toward the live ETH price, and makes a small round trip when
/// nothing needs correcting, so fees accrue. Gas is real Sepolia ETH, so it
/// trades sparingly: every AQUA_SIM_INTERVAL_MS, at most MAX_TRADES swaps.

const MAX_TRADES = Number(process.env.AQUA_SIM_MAX_TRADES ?? 2);
const MAX_TRADE_USD = 3;
const MIN_TRADE_USD = 0.05;
const MAX_SHARE_OF_BALANCE = 0.2; // never take more than this of what a strategy holds
const erc20Abi = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);

const swapVM = () => new sv.SwapVMContract(new sv.Address(config.aqua.router));
const toAddr = (a: string) => new sv.Address(a);

interface Quote {
  amountIn: bigint;
  amountOut: bigint;
}

async function quote(orderHex: string, tokenIn: string, tokenOut: string, amount: bigint): Promise<Quote | null> {
  const order = sv.Order.decode(new sv.HexString(orderHex));
  const q = swapVM().quote({ order, amount, takerTraits: sv.TakerTraits.default(), tokenIn: toAddr(tokenIn), tokenOut: toAddr(tokenOut) });
  try {
    const res = await publicClient.call({ account: treasuryAddress, to: q.to.toString() as Address, data: q.data.toString() as `0x${string}` });
    const out = decodeFunctionResult({ abi: sv.ABI.SWAP_VM_ABI, functionName: "quote", data: res.data! }) as readonly bigint[];
    return { amountIn: out[0]!, amountOut: out[1]! };
  } catch {
    return null; // e.g. a one-sided bin can't sell the token it doesn't hold
  }
}

function swapTx(orderHex: string, tokenIn: string, tokenOut: string, amount: bigint) {
  const order = sv.Order.decode(new sv.HexString(orderHex));
  const tx = swapVM().swap({ order, amount, takerTraits: sv.TakerTraits.default(), tokenIn: toAddr(tokenIn), tokenOut: toAddr(tokenOut) });
  return { to: tx.to.toString() as Address, data: tx.data.toString() as `0x${string}` };
}

let approved = false;
async function ensureRouterApprovals() {
  if (approved) return;
  for (const token of [PAIR.eth.address, PAIR.usdc.address] as Address[]) {
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [treasuryAddress!, config.aqua.router as Address] });
    if (allowance < 10n ** 40n) {
      await sendTreasuryTx({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.aqua.router as Address, maxUint256] }) });
    }
  }
  approved = true;
}

const ETH = 10n ** 18n;
const USDC = 10n ** 6n;
const usdcFor = (usd: number) => BigInt(Math.max(1, Math.floor(usd * 1e6)));
const ethFor = (usd: number, spot: number) => BigInt(Math.max(1, Math.floor((usd / spot) * 1e12))) * 10n ** 6n;

interface Candidate {
  order: string;
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  gap: number; // how far the strategy's price is from the market, as a fraction
  reason: string;
}

/// One round: find strategies priced away from the market and correct them.
export async function simulateOnce(): Promise<string[]> {
  if (!treasuryAddress) return [];
  const spot = await ethUsd();
  const strategies = (await openPositions()).flatMap((p) => p.strategies).slice(0, 30);
  if (!strategies.length) return [];
  const candidates: Candidate[] = [];
  for (const s of strategies) {
    // Size trades to what this strategy can pay out.
    const bal = await strategyBalances(s.hash).catch(() => null);
    if (!bal) continue;
    const ethUsdHeld = (Number(bal.eth) / Number(ETH)) * spot;
    const usdcHeld = Number(bal.usdc) / Number(USDC);
    const buyUsd = Math.min(MAX_TRADE_USD, ethUsdHeld * MAX_SHARE_OF_BALANCE); // ETH comes out
    const sellUsd = Math.min(MAX_TRADE_USD, usdcHeld * MAX_SHARE_OF_BALANCE); // USDC comes out
    const [buy, sell] = await Promise.all([
      buyUsd >= MIN_TRADE_USD ? quote(s.order, PAIR.usdc.address, PAIR.eth.address, usdcFor(buyUsd)) : null,
      sellUsd >= MIN_TRADE_USD ? quote(s.order, PAIR.eth.address, PAIR.usdc.address, ethFor(sellUsd, spot)) : null,
    ]);
    // Effective prices, USD per ETH.
    const buyPrice = buy && buy.amountOut > 0n ? Number(buy.amountIn) / Number(USDC) / (Number(buy.amountOut) / Number(ETH)) : null;
    const sellPrice = sell && sell.amountIn > 0n ? Number(sell.amountOut) / Number(USDC) / (Number(sell.amountIn) / Number(ETH)) : null;
    if (buyPrice !== null && buyPrice < spot) {
      // It sells ETH below market: buy from it, which raises its price.
      candidates.push({ order: s.order, tokenIn: PAIR.usdc.address, tokenOut: PAIR.eth.address, amount: usdcFor(buyUsd), gap: (spot - buyPrice) / spot, reason: `buy ETH at $${buyPrice.toFixed(0)} < $${spot.toFixed(0)}` });
    } else if (sellPrice !== null && sellPrice > spot) {
      // It buys ETH above market: sell to it, which lowers its price.
      candidates.push({ order: s.order, tokenIn: PAIR.eth.address, tokenOut: PAIR.usdc.address, amount: ethFor(sellUsd, spot), gap: (sellPrice - spot) / spot, reason: `sell ETH at $${sellPrice.toFixed(0)} > $${spot.toFixed(0)}` });
    } else if (buyPrice !== null && sellPrice !== null) {
      candidates.push({ order: s.order, tokenIn: PAIR.usdc.address, tokenOut: PAIR.eth.address, amount: usdcFor(Math.min(buyUsd, sellUsd)), gap: 0, reason: "round trip (fees)" });
    }
  }

  // Worst-priced first; if nothing is off, one small round trip.
  const off = candidates.filter((c) => c.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, MAX_TRADES);
  const picks = off.length ? off : candidates.filter((c) => c.gap === 0).slice(0, 1);
  if (!picks.length) return [];

  await ensureRouterApprovals();
  const done: string[] = [];
  const hashes: `0x${string}`[] = [];
  for (const c of picks) {
    try {
      // Quote first so the reverse leg of a round trip knows what came out.
      const out = await quote(c.order, c.tokenIn, c.tokenOut, c.amount);
      hashes.push(await sendTreasuryTxNoWait(swapTx(c.order, c.tokenIn, c.tokenOut, c.amount)));
      if (c.gap === 0 && out) {
        // Round trip: sell back ~99% of what came out once the first leg lands.
        await waitForTx(hashes[hashes.length - 1]!);
        hashes.push(await sendTreasuryTxNoWait(swapTx(c.order, c.tokenOut, c.tokenIn, (out.amountOut * 99n) / 100n)));
      }
      done.push(c.reason);
    } catch (err) {
      console.error(`[aqua-sim] skipped (${c.reason}):`, err instanceof Error ? err.message.split("\n")[0] : err);
    }
  }
  await Promise.all(hashes.map((h) => waitForTx(h).catch((err) => console.error("[aqua-sim] swap failed:", err.message))));
  return done;
}

let timer: NodeJS.Timeout | null = null;

export function startAquaSimulator() {
  if (!config.aqua.simEnabled || timer) return;
  const tick = () =>
    simulateOnce()
      .then((trades) => trades.length && console.log(`[aqua-sim] ${trades.join("; ")}`))
      .catch((err) => console.error("[aqua-sim]", err instanceof Error ? err.message : err));
  timer = setInterval(tick, config.aqua.simIntervalMs);
  console.log(`[aqua-sim] trading against open strategies every ${Math.round(config.aqua.simIntervalMs / 1000)}s (max ${MAX_TRADES} swaps)`);
}
