import { maxUint256 } from "viem";
import { sv } from "./aquaSdk.js";

/// Pure maths for 1inch Aqua positions: the beginner tiers, how an advanced
/// range splits into bins for each liquidity shape, and how many tokens each
/// bin needs so its SwapVM strategy starts at the market price.

export type Tier = "low" | "medium" | "high";
export type Shape = "full" | "spot" | "curve" | "bidask" | "hybrid";

export interface TierPlan {
  tier: Tier;
  label: string;
  description: string;
  rangePct: number | null; // ± around spot; null = full range
  feeBps: number;
  apyEstBps: number; // shown as an estimate, not a promise
}

/// Beginner tiers: same pair (mETH/mUSDC), narrower range = more fees per
/// dollar but more impermanent loss and more time out of range.
export const TIERS: Record<Tier, TierPlan> = {
  low: {
    tier: "low",
    label: "Steady",
    description: "Full-range liquidity. Always earning, smallest swings — like a classic x·y=k pool.",
    rangePct: null,
    feeBps: 30,
    apyEstBps: 400,
  },
  medium: {
    tier: "medium",
    label: "Balanced",
    description: "Concentrated within ±25% of today's ETH price. More fees while ETH stays in that band.",
    rangePct: 25,
    feeBps: 30,
    apyEstBps: 900,
  },
  high: {
    tier: "high",
    label: "Bold",
    description: "Tight ±8% range. Highest fees while the price holds, but it stops earning if ETH moves far.",
    rangePct: 8,
    feeBps: 30,
    apyEstBps: 1800,
  },
};

/// Limits for the advanced range picker.
export const ADVANCED = {
  minFractionOfSpot: 0.1, // −90%
  maxMultipleOfSpot: 4, // +300%
  bins: 5,
  // Hybrid: a tight core around the price plus the whole range as a tail.
  hybridCoreHalfWidth: 0.08, // core is ±8% of the current price
  hybridCoreWeight: 0.7, // share of the position in the core
  // A Hybrid the customer builds: this share spread evenly, the rest in a few shaped bins.
  hybridSpotWeight: 0.5,
  hybridShapedBins: 3,
  feeBps: 30,
  apyEstBps: 1200,
} as const;

export interface Bin {
  min: number; // USD per ETH
  max: number;
  weight: number; // share of the position's USD, sums to 1
}

/// What the customer chooses for a Hybrid: the shape combined with Spot, and which tokens it holds
/// ("base" is the priced token such as ETH, "quote" the one it is priced in, such as USDC).
export interface HybridOptions {
  mix: "curve" | "bidask";
  side: "both" | "base" | "quote";
}

/// A range only holds one token while it sits wholly on one side of the price (see `allocate`), so a
/// one-sided choice is checked against the price at the moment it is used. If the price has moved into
/// the range this refuses, rather than quietly opening a position holding both tokens.
function assertSide(side: HybridOptions["side"], min: number, max: number, spot: number) {
  if (side === "base" && min < spot) throw new Error(`holding only the base token needs a price range above today's price ($${spot.toFixed(2)}): move the lower price up`);
  if (side === "quote" && max > spot) throw new Error(`holding only the quote token needs a price range below today's price ($${spot.toFixed(2)}): move the upper price down`);
}

/// Splits [min, max] into bins for a liquidity shape. Each bin becomes one
/// SwapVM concentrated-liquidity strategy, which holds its liquidity evenly
/// across its own range; weighting the bins draws the shape.
///   spot   — one even range
///   curve  — more liquidity near the current price, tapering away from it
///   bidask — more liquidity far from the current price (buy low / sell high)
///   hybrid — a tight core around the price (most of the money, most of the
///            fees) plus the whole range as a tail, so the position keeps
///            earning when the price leaves the core. With `hybrid` choices it
///            is instead one even range plus a few bins of the chosen shape.
export function binsFor(shape: Exclude<Shape, "full">, min: number, max: number, spot: number, n: number = ADVANCED.bins, hybrid?: HybridOptions): Bin[] {
  if (!(min > 0 && max > min)) throw new Error("price range must have 0 < min < max");
  if (hybrid && shape !== "hybrid") throw new Error("mix and token choices only apply to a Hybrid position");
  if (shape === "spot") return [{ min, max, weight: 1 }];

  if (hybrid) {
    assertSide(hybrid.side, min, max, spot);
    const shaped = binsFor(hybrid.mix, min, max, spot, ADVANCED.hybridShapedBins);
    const spotWeight = ADVANCED.hybridSpotWeight;
    return [{ min, max, weight: spotWeight }, ...shaped.map((b) => ({ ...b, weight: b.weight * (1 - spotWeight) }))];
  }

  if (shape === "hybrid") {
    const lo = Math.max(min, spot * (1 - ADVANCED.hybridCoreHalfWidth));
    const hi = Math.min(max, spot * (1 + ADVANCED.hybridCoreHalfWidth));
    // A range that sits away from the price has no core to add: one even bin.
    if (!(hi > lo)) return [{ min, max, weight: 1 }];
    return [
      { min: lo, max: hi, weight: ADVANCED.hybridCoreWeight },
      { min, max, weight: 1 - ADVANCED.hybridCoreWeight },
    ];
  }

  // Equal widths in log-price, so each bin covers the same % move.
  const ratio = Math.pow(max / min, 1 / n);
  const span = Math.log(max / min);
  const raw = Array.from({ length: n }, (_, i) => {
    const lo = min * Math.pow(ratio, i);
    const hi = i === n - 1 ? max : min * Math.pow(ratio, i + 1);
    const center = Math.sqrt(lo * hi);
    const d = Math.min(1, Math.abs(Math.log(center / spot)) / span); // 0 at spot, 1 at the far side
    const weight = shape === "curve" ? 1 - 0.8 * d : 0.2 + 0.8 * d;
    return { min: lo, max: hi, weight };
  });
  const total = raw.reduce((s, b) => s + b.weight, 0);
  return raw.map((b) => ({ ...b, weight: b.weight / total }));
}

export interface PairTokens {
  eth: { address: string; decimals: bigint };
  usdc: { address: string; decimals: bigint };
}

export function sdkPrice(usdPerEth: number, t: PairTokens) {
  return sv.instructions.concentrate.Price.fromHuman(usdPerEth.toFixed(6), {
    quoteToken: { address: new sv.Address(t.usdc.address), decimals: t.usdc.decimals },
    baseToken: { address: new sv.Address(t.eth.address), decimals: t.eth.decimals },
  });
}

/// SwapVM's sqrt-price bounds for a USD range, lowest first. P is quoted as
/// tokenGt/tokenLt by address, so the order depends on which token sorts first.
export function sqrtBounds(min: number, max: number, t: PairTokens): [bigint, bigint] {
  const a = sdkPrice(min, t).toSqrt();
  const b = sdkPrice(max, t).toSqrt();
  return a < b ? [a, b] : [b, a];
}

const ethIsLt = (t: PairTokens) => t.eth.address.toLowerCase() < t.usdc.address.toLowerCase();

/// Token amounts for a bin worth `usd` at `spot`, such that the strategy's
/// implied price equals the market price:
///   range entirely above spot → ETH only (an ask: sells as ETH rises into it)
///   range entirely below spot → USDC only (a bid: buys as ETH falls into it)
///   range around spot         → both, in the ratio the range requires
export function allocate(usd: number, bin: { min: number; max: number } | null, spot: number, t: PairTokens): { eth: bigint; usdc: bigint } {
  const ethUnit = 10n ** t.eth.decimals;
  const usdcUnit = 10n ** t.usdc.decimals;
  // Multiply before dividing: ethUnit / 1e9 is 0 for a token with fewer than 9 decimals (EURC has 6).
  const toEth = (usdValue: number) => (BigInt(Math.floor((usdValue / spot) * 1e9)) * ethUnit) / 10n ** 9n;
  const toUsdc = (usdValue: number) => BigInt(Math.floor(usdValue * Number(usdcUnit)));

  if (bin === null) return { eth: toEth(usd / 2), usdc: toUsdc(usd / 2) }; // full range: 50/50 at spot
  if (spot <= bin.min) return { eth: toEth(usd), usdc: 0n };
  if (spot >= bin.max) return { eth: 0n, usdc: toUsdc(usd) };

  // Around spot: ask SwapVM's maths for the ratio with 1 ETH, then scale.
  const [sMin, sMax] = sqrtBounds(bin.min, bin.max, t);
  const sSpot = sdkPrice(spot, t).toSqrt();
  const { computeLiquidityFromAmounts } = sv.instructions.concentrate;
  const { actualLt, actualGt } = ethIsLt(t)
    ? computeLiquidityFromAmounts(ethUnit, maxUint256, sSpot, sMin, sMax)
    : computeLiquidityFromAmounts(maxUint256, ethUnit, sSpot, sMin, sMax);
  const [ethPer, usdcPer] = ethIsLt(t) ? [actualLt, actualGt] : [actualGt, actualLt];
  const unitValue = (Number(ethPer) / Number(ethUnit)) * spot + Number(usdcPer) / Number(usdcUnit);
  const scale = usd / unitValue;
  return {
    eth: BigInt(Math.floor(Number(ethPer) * scale)),
    usdc: BigInt(Math.floor(Number(usdcPer) * scale)),
  };
}

/// A base token's raw amount in whole tokens, by its own decimals (EURC has 6, not 18).
export const baseAmount = (raw: bigint, t: PairTokens) => Number(raw) / Number(10n ** t.eth.decimals);

/// USD value of token balances at a price.
export function valueUsd(eth: bigint, usdc: bigint, spot: number, t: PairTokens): number {
  return (Number(eth) / Number(10n ** t.eth.decimals)) * spot + Number(usdc) / Number(10n ** t.usdc.decimals);
}
