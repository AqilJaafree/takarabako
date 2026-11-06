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

/// For tests: forget the cached price.
export function resetEurcPriceCache() {
  cache = null;
}
