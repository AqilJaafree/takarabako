import type { PreviewBin } from "./types";

export interface LiquiditySlice {
  min: number;
  max: number;
  /// The liquidity across this slice of prices, added up over every strategy covering it: how much a
  /// trade here meets, which is what "concentrated" means. Only comparable within one profile.
  depth: number;
  /// Which token this slice holds: the quote token below the price, the base token above it.
  side: "usdc" | "eth";
  usd: number;
  eth: number;
  usdc: number;
}

/// A position's strategies as one profile over price. Strategies can overlap (a Hybrid's Spot covers the
/// whole range under its shaped ones), so the range is cut at every strategy's edges and at the price,
/// and each slice adds up what covers it. Depth is concentrated liquidity's L, which is even across a
/// strategy's range in the square root of price, whatever the strategy's width.
export function liquidityProfile(bins: PreviewBin[], spot: number): LiquiditySlice[] {
  const ranges = bins.flatMap((b) => {
    if (b.min === null || b.max === null || !(b.max > b.min) || !(b.usd > 0)) return [];
    // What one unit of liquidity holds in this strategy at the price.
    const ethUnit = spot < b.max ? 1 / Math.sqrt(Math.max(spot, b.min)) - 1 / Math.sqrt(b.max) : 0;
    const usdcUnit = spot > b.min ? Math.sqrt(Math.min(spot, b.max)) - Math.sqrt(b.min) : 0;
    return [{ min: b.min, max: b.max, eth: b.eth, usdc: b.usdc, ethUnit, usdcUnit, depth: b.usd / (ethUnit * spot + usdcUnit) }];
  });
  const edges = [...new Set([spot, ...ranges.flatMap((r) => [r.min, r.max])])].sort((a, b) => a - b);
  const slices: LiquiditySlice[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const min = edges[i]!;
    const max = edges[i + 1]!;
    const covering = ranges.filter((r) => r.min <= min && r.max >= max);
    if (covering.length === 0) continue;
    const side = max <= spot ? "usdc" : "eth";
    let eth = 0;
    let usdc = 0;
    for (const r of covering) {
      // This slice's share of the strategy's actual tokens, so nothing is lost or invented.
      if (side === "eth") eth += (r.eth * (1 / Math.sqrt(min) - 1 / Math.sqrt(max))) / r.ethUnit;
      else usdc += (r.usdc * (Math.sqrt(max) - Math.sqrt(min))) / r.usdcUnit;
    }
    slices.push({ min, max, side, eth, usdc, usd: eth * spot + usdc, depth: covering.reduce((t, r) => t + r.depth, 0) });
  }
  return slices;
}
