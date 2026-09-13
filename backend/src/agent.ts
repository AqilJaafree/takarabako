import Anthropic from "@anthropic-ai/sdk";
import { formatUnits, type Address } from "viem";
import { config } from "./config.js";
import type { RiskTier } from "./store.js";
import { mintPositionOnChain, exitPositionOnChain, chainReady, treasuryAddress } from "./chain.js";

/// PRD §7.9 — the agentic Uniswap v3/v4 yield manager. Pool *selection*
/// now goes through a real Claude Haiku 4.5 call (chooseRiskTierWithAgent
/// below) rather than a bare lookup, and opening/exiting a position mints
/// a genuine new LP NFT into a real, live pool on Sepolia (DEPLOYMENTS.md).
///
/// Security model (PRD §10): the agent holds no keys and no unilateral
/// authority over which risk tier gets used — the user's own tier choice
/// is the guardrail, not Claude's judgment. The model's real job here is
/// to confirm that choice against the live pool data and produce a
/// human-readable rationale; chooseRiskTierWithAgent rejects (falls back
/// on) any response that tries to pick a different tier than requested,
/// and any API failure degrades to a plain default rationale rather than
/// blocking the mint — the LLM call is additive, not a hard dependency.
///
/// The treasury supplies the non-USDC side of every position (WETH for
/// low, mAAVE/mDOGE — both freely mintable mocks — for medium/high) since
/// the user only ever holds USDC. Amounts are small, fixed, demo-scale —
/// not literally proportional to the user's deposit — because real ETH is
/// scarce even though the mock risk tokens aren't; see the "why" note on
/// each pool below.

interface PoolConfig {
  pair: string;
  baseApyBps: number;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  mintAmount0: bigint;
  mintAmount1: bigint;
  usdcIsToken0: boolean;
  // USDC value of 1 whole unit of the non-USDC token, for valuing an exit's
  // mixed-token proceeds in USDC terms — a fixed rate, not a live oracle.
  counterpartUsdcPrice: number;
  counterpartDecimals: number;
}

const USDC = "0x6cc5f175810e61A56508049f0527BC75EB7e77e4" as const;
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as const;
const AAVE = "0x9c57968055d77d765e4EF1E4F138e9089295eD04" as const;
const DOGE = "0x071436DC66a7C86a7c12Bc7E337A05fb46908c38" as const;

// See DEPLOYMENTS.md for how these addresses/amounts/ticks were derived
// and independently verified before any real transaction used them.
const RISK_POOLS: Record<RiskTier, PoolConfig> = {
  low: {
    pair: "USDC/ETH",
    baseApyBps: 320,
    poolAddress: "0xE8Dd26347E5Ef1D98946D81b681db1bC4dEeC44d",
    token0: USDC,
    token1: WETH,
    fee: 3000,
    tickLower: -887220,
    tickUpper: 887220,
    mintAmount0: 1_000_000n, // 1 USDC
    mintAmount1: 333_333_333_333_333n, // ~0.000333 WETH — real ETH is the scarce side here
    usdcIsToken0: true,
    counterpartUsdcPrice: 3000,
    counterpartDecimals: 18,
  },
  medium: {
    pair: "USDC/AAVE",
    baseApyBps: 610,
    poolAddress: "0xb9a463fdBC9f1be53d582351b631e0EC277B16e0",
    token0: USDC,
    token1: AAVE,
    fee: 3000,
    tickLower: -887220,
    tickUpper: 887220,
    mintAmount0: 10_000_000n, // 10 USDC
    mintAmount1: 100_000_000_000_000_000n, // 0.1 mAAVE
    usdcIsToken0: true,
    counterpartUsdcPrice: 100,
    counterpartDecimals: 18,
  },
  high: {
    pair: "USDC/DOGE",
    baseApyBps: 1450,
    poolAddress: "0x90999138f8b1B69b953239Eb1F0D991e601Bbfe2",
    token0: DOGE,
    token1: USDC,
    fee: 10000,
    tickLower: -887200,
    tickUpper: 887200,
    mintAmount0: 100_000_000_000_000_000_000n, // 100 mDOGE
    mintAmount1: 10_000_000n, // 10 USDC
    usdcIsToken0: false,
    counterpartUsdcPrice: 0.1,
    counterpartDecimals: 18,
  },
};

export interface OpenPositionResult {
  pair: string;
  apyBps: number;
  tokenId: string;
  txHash: string;
  rationale: string;
}

export interface PoolInfo {
  riskTier: RiskTier;
  pair: string;
  apyBps: number;
  poolAddress: Address;
  feeBps: number;
  fullRange: boolean;
  // USDC price of one whole unit of the non-USDC asset at the position's
  // tick bounds — null when fullRange (the bounds are ~0 and ~infinity,
  // so a number would be technically-finite but meaningless to show).
  priceLowUsdc: number | null;
  priceHighUsdc: number | null;
}

// Uniswap v3 standard fee -> tick spacing (the tiers this app actually
// uses; see DEPLOYMENTS.md for the exact ticks each pool was seeded with).
const TICK_SPACING_BY_FEE: Record<number, number> = { 500: 10, 3000: 60, 10000: 200 };
const MIN_TICK = -887272;
const MAX_TICK = 887272;

function isFullRange(pool: PoolConfig): boolean {
  const spacing = TICK_SPACING_BY_FEE[pool.fee];
  const minAligned = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxAligned = Math.floor(MAX_TICK / spacing) * spacing;
  return pool.tickLower <= minAligned && pool.tickUpper >= maxAligned;
}

// USDC price of one unit of the non-USDC asset at a given tick, using the
// standard Uniswap v3 tick->price relation (price = 1.0001^tick, adjusted
// for each token's decimals) rather than a hardcoded number.
function usdcPriceAtTick(tick: number, pool: PoolConfig): number {
  const usdcDecimals = 6;
  const assetDecimals = pool.counterpartDecimals;
  return pool.usdcIsToken0
    ? Math.pow(1.0001, -tick) * Math.pow(10, assetDecimals - usdcDecimals)
    : Math.pow(1.0001, tick) * Math.pow(10, assetDecimals - usdcDecimals);
}

/// Public pool metadata for the kiosk's dedicated yield page — pair, fee
/// tier, the position's price range (or "full range" when it truly spans
/// ~0 to ~infinity, which is what every pool here is seeded with today —
/// see DEPLOYMENTS.md), live APY estimate, and the actual Uniswap v3 pool
/// address a deposit at this risk level mints liquidity into.
export function getPoolsInfo(): PoolInfo[] {
  return (Object.entries(RISK_POOLS) as [RiskTier, PoolConfig][]).map(([riskTier, pool]) => {
    const fullRange = isFullRange(pool);
    let priceLowUsdc: number | null = null;
    let priceHighUsdc: number | null = null;
    if (!fullRange) {
      const a = usdcPriceAtTick(pool.tickLower, pool);
      const b = usdcPriceAtTick(pool.tickUpper, pool);
      priceLowUsdc = Math.min(a, b);
      priceHighUsdc = Math.max(a, b);
    }
    return {
      riskTier,
      pair: pool.pair,
      apyBps: pool.baseApyBps,
      poolAddress: pool.poolAddress,
      feeBps: pool.fee / 100,
      fullRange,
      priceLowUsdc,
      priceHighUsdc,
    };
  });
}

const anthropic = config.agent.apiKey ? new Anthropic({ apiKey: config.agent.apiKey }) : null;

const DEFAULT_RATIONALE: Record<RiskTier, string> = {
  low: "Full-range USDC/ETH liquidity — the steadiest pair available, matching a low-risk request.",
  medium: "Full-range USDC/AAVE liquidity — a real DeFi asset with more upside than the low tier.",
  high: "Full-range USDC/DOGE liquidity — the most volatile pair on offer, matching a high-risk request.",
};

interface AgentDecision {
  riskTier: RiskTier;
  rationale: string;
}

/// Real Claude Haiku 4.5 call: given the live pool data for all three
/// tiers and the user's requested tier + amount, asks the model to confirm
/// the tier-matching pool and explain why in one sentence. Never lets the
/// model's output override the user's own risk choice — see the security
/// note above — and falls back to a canned rationale on any failure so a
/// flaky/missing API key never blocks a real mint.
async function chooseRiskTierWithAgent(riskTier: RiskTier, amount: number): Promise<AgentDecision> {
  if (!anthropic) {
    console.log(`[agent] no ANTHROPIC_API_KEY configured — using default rationale for risk=${riskTier}`);
    return { riskTier, rationale: DEFAULT_RATIONALE[riskTier] };
  }

  const pools = getPoolsInfo().map((p) => ({
    riskTier: p.riskTier,
    pair: p.pair,
    feePercent: p.feeBps / 100,
    apyPercent: p.apyBps / 100,
  }));

  try {
    const response = await anthropic.messages.create({
      model: config.agent.model,
      max_tokens: 300,
      system:
        "You are the yield-selection agent for Takarabako, a cash-in kiosk that routes deposits into " +
        "risk-tiered Uniswap v3 positions. You do not hold funds or choose the user's risk tier — a " +
        "human already picked one on the kiosk screen. Your only job: confirm the pool that matches " +
        "their chosen tier from the real, live options given, and write one short, honest sentence " +
        "explaining why it fits that tier. Reply with ONLY a JSON object: " +
        `{"riskTier": "low"|"medium"|"high", "rationale": "..."}`,
      messages: [
        {
          role: "user",
          content: `User selected risk tier: ${riskTier}. Deposit amount: $${amount}. Live pools:\n${JSON.stringify(pools, null, 2)}`,
        },
      ],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("no text block in Claude response");

    // Haiku sometimes wraps JSON in a markdown code fence despite being
    // told not to — strip it before parsing rather than fail on it.
    const raw = textBlock.text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(raw) as Partial<AgentDecision>;
    if (parsed.riskTier !== riskTier) {
      console.warn(`[agent] Claude proposed tier "${parsed.riskTier}" but user requested "${riskTier}" — keeping the user's choice`);
    }
    if (!parsed.rationale) throw new Error("missing rationale in Claude response");

    console.log(`[agent] model=${config.agent.model} confirmed risk=${riskTier}: "${parsed.rationale}"`);
    return { riskTier, rationale: parsed.rationale };
  } catch (err) {
    console.error(`[agent] Claude call failed, falling back to default rationale:`, err);
    return { riskTier, rationale: DEFAULT_RATIONALE[riskTier] };
  }
}

export async function proposeOpenPosition(riskTier: RiskTier, amount: number): Promise<OpenPositionResult> {
  const pool = RISK_POOLS[riskTier];
  const decision = await chooseRiskTierWithAgent(riskTier, amount);

  if (!chainReady || !treasuryAddress) throw new Error("chain not configured — cannot open a real position");

  const { tokenId, txHash } = await mintPositionOnChain({
    token0: pool.token0,
    token1: pool.token1,
    fee: pool.fee,
    tickLower: pool.tickLower,
    tickUpper: pool.tickUpper,
    amount0Desired: pool.mintAmount0,
    amount1Desired: pool.mintAmount1,
    recipient: treasuryAddress,
  });

  return { pair: pool.pair, apyBps: pool.baseApyBps, tokenId: tokenId.toString(), txHash, rationale: decision.rationale };
}

export async function proposeExitAll(
  positions: { pair: string; amount: number; apyBps: number; riskTier?: RiskTier; nftTokenId?: string }[],
) {
  if (!chainReady || !treasuryAddress) return { grossUsdc: positions.reduce((sum, p) => sum + p.amount, 0) };

  let grossUsdc = 0;

  for (const position of positions) {
    if (!position.riskTier || !position.nftTokenId) {
      // Legacy/simulated position with no real NFT — fall back to its
      // recorded demo amount rather than dropping it from the receipt.
      grossUsdc += position.amount;
      continue;
    }
    const pool = RISK_POOLS[position.riskTier];
    const { amount0, amount1 } = await exitPositionOnChain(BigInt(position.nftTokenId), treasuryAddress!);

    const usdcRaw = pool.usdcIsToken0 ? amount0 : amount1;
    const counterpartRaw = pool.usdcIsToken0 ? amount1 : amount0;
    const usdcAmount = Number(formatUnits(usdcRaw, 6));
    const counterpartAmount = Number(formatUnits(counterpartRaw, pool.counterpartDecimals));
    grossUsdc += usdcAmount + counterpartAmount * pool.counterpartUsdcPrice;
  }

  console.log(`[agent] exited ${positions.length} real position(s), gross ${grossUsdc.toFixed(6)} USDC-equivalent`);
  return { grossUsdc };
}
