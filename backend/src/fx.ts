import { config } from "./config.js";

/// Converts a cash deposit's local currency into the USD amount the vault is
/// credited in (the vault holds USDC). The bill acceptor reports ringgit; the
/// fallback button and older callers send USD.
///
/// Rate sources, in order:
///   1. MYR_USD_RATE in backend/.env: a fixed rate, for demos that must not
///      move mid-presentation.
///   2. open.er-api.com (free, no key), cached for an hour.
///   3. The last live rate fetched, or FALLBACK_USD_PER_MYR if none ever was.

export type Currency = "USD" | "MYR";

// open.er-api.com, 25 Sep 2026 00:02 UTC: 1 MYR = 0.244881 USD.
const FALLBACK_USD_PER_MYR = 0.244881;
const LIVE_RATE_URL = "https://open.er-api.com/v6/latest/MYR";
const CACHE_MS = 60 * 60 * 1000;

let cached: { rate: number; fetchedAt: number } | null = null;

async function liveUsdPerMyr(): Promise<{ rate: number; source: string }> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return { rate: cached.rate, source: "live (cached)" };
  }
  try {
    const res = await fetch(LIVE_RATE_URL, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
    const rate = body.rates?.USD;
    if (body.result !== "success" || !(typeof rate === "number" && rate > 0)) throw new Error("no USD rate in response");
    cached = { rate, fetchedAt: Date.now() };
    return { rate, source: "live" };
  } catch (err) {
    console.warn(`[fx] live MYR rate unavailable (${err instanceof Error ? err.message : err})`);
    if (cached) return { rate: cached.rate, source: "live (stale)" };
    return { rate: FALLBACK_USD_PER_MYR, source: "fallback 2026-09-25" };
  }
}

export async function usdPerUnit(currency: Currency): Promise<{ rate: number; source: string }> {
  if (currency === "USD") return { rate: 1, source: "identity" };
  if (config.fx.myrUsdRate > 0) return { rate: config.fx.myrUsdRate, source: "MYR_USD_RATE" };
  return liveUsdPerMyr();
}

/// USDC has 6 decimals; rounding here keeps float noise like
/// 2.4488100000000003 out of parseUnits.
export async function toUsd(amount: number, currency: Currency) {
  const { rate, source } = await usdPerUnit(currency);
  return { usdAmount: Math.round(amount * rate * 1e6) / 1e6, rate, source };
}
