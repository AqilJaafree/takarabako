import { createPublicClient, http } from "viem";
import { arc } from "viem/chains";
import { config } from "./config.js";
import { GuardError } from "./guards.js";

/// The price of EURC in USDC (about the EUR/USD rate), for the EURC/USDC pair. It moves money, so it is
/// read from two independent places that must agree, like the ETH price (aqua.ts ethUsd): the deepest
/// EURC/USDC pool on Arc (where trades actually happen) and the ECB reference rate (Frankfurter).

/// The biggest EURC/USDC pool on Arc: a Uniswap-v3-style pool with USDC as token0 and EURC as token1,
/// both 6 decimals, so sqrtPriceX96^2 is EURC per USDC.
const POOL = "0x6f57b4c22155cef09f17184c954f227ff0493742" as const;
const SLOT0 = "0x3850c7bd" as const;

/// How far the two sources may differ before the price is refused (the pool trades a little away from the
/// reference rate, but not by this much unless something is wrong).
export const EURC_FEEDS_TOLERANCE = 0.015;

export const feedsAgreeWithin = (a: number, b: number, tolerance = EURC_FEEDS_TOLERANCE) => a > 0 && b > 0 && Math.abs(a - b) / Math.min(a, b) <= tolerance;

/// EURC per USDC from a pool's slot0 word, inverted to USDC per EURC.
export function priceFromSqrtX96(sqrtPriceX96: bigint): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  return 1 / (sqrt * sqrt);
}

let cache: { at: number; price: number } | null = null;
let warnedAt = 0;

async function poolPrice(): Promise<number> {
  const client = createPublicClient({ chain: arc, transport: http(config.selfCustody.arcRpcUrl, { timeout: 8_000 }) });
  const res = await client.call({ to: POOL, data: SLOT0 });
  if (!res.data || res.data.length < 66) throw new Error("the EURC/USDC pool did not answer");
  return priceFromSqrtX96(BigInt(`0x${res.data.slice(2, 66)}`));
}

async function referenceRate(): Promise<number | null> {
  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD", { signal: AbortSignal.timeout(5_000) });
    const rate = Number((await res.json()).rates?.USD);
    return rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/// USDC per EURC. Throws (GuardError) if the pool and the reference rate disagree, or the pool cannot be read.
export async function eurcUsdc(): Promise<number> {
  if (cache && Date.now() - cache.at < 30_000) return cache.price;
  let pool: number;
  try {
    pool = await poolPrice();
  } catch (e) {
    throw new GuardError(`the EURC price is unavailable: ${e instanceof Error ? e.message : e}`);
  }
  const ref = await referenceRate();
  if (ref === null) {
    if (Date.now() - warnedAt > 10 * 60_000) {
      warnedAt = Date.now();
      console.warn("[price] the EUR/USD reference rate is unreachable: using the Arc pool's EURC price alone");
    }
  } else if (!feedsAgreeWithin(pool, ref)) {
    throw new GuardError(`the EURC price sources disagree (Arc pool $${pool.toFixed(4)}, ECB $${ref.toFixed(4)}): not moving money until they agree`);
  }
  cache = { at: Date.now(), price: pool };
  return pool;
}

const CANDLE_MAX_AGE_SECONDS = 6 * 3600;
const WEEK_OF_HOURS = 168;

/// Coinbase's candle rows (newest first: time, low, high, open, close, volume) as a week of candles, oldest
/// first. A feed can stop updating and still answer normally, so one whose newest candle is old gives none.
export function candlesFromCoinbase(rows: unknown, nowSeconds: number) {
  if (!Array.isArray(rows)) return [];
  const usable = rows.filter((r): r is number[] => Array.isArray(r) && r.length >= 5 && r.slice(0, 5).every((v) => typeof v === "number" && v > 0));
  if (usable.length === 0 || nowSeconds - usable[0]![0]! > CANDLE_MAX_AGE_SECONDS) return [];
  return usable
    .slice(0, WEEK_OF_HOURS)
    .map(([t, l, h, o, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c! }))
    .reverse();
}

let candleCache: { at: number; candles: ReturnType<typeof candlesFromCoinbase> } | null = null;

/// Hourly EURC/USDC candles for the chart, cached 5 min. Only for drawing: money uses eurcUsdc above.
/// This is EURC-USDC because Coinbase's EURC-USD product stopped updating in 2024.
export async function eurcCandles() {
  if (candleCache && Date.now() - candleCache.at < 300_000) return candleCache.candles;
  const res = await fetch("https://api.exchange.coinbase.com/products/EURC-USDC/candles?granularity=3600", {
    headers: { "user-agent": "takarabako" },
    signal: AbortSignal.timeout(8000),
  });
  const candles = candlesFromCoinbase(await res.json(), Math.floor(Date.now() / 1000));
  candleCache = { at: Date.now(), candles };
  return candles;
}

/// For tests: forget the cached price.
export function resetEurcPriceCache() {
  cache = null;
}
