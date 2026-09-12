import { formatUnits, type Address } from "viem";
import { config } from "./config.js";
import type { RiskTier } from "./store.js";
import { mintPositionOnChain, exitPositionOnChain, chainReady, treasuryAddress } from "./chain.js";

/// PRD §7.9 — the agentic Uniswap v3/v4 yield manager. Pool selection is
/// still a hardcoded map, not a Claude Haiku decision (that needs its own
/// ANTHROPIC_API_KEY — see DEPLOYMENTS.md) — but opening/exiting a position
/// is now real: a genuine new LP NFT minted into a real, live pool on
/// Sepolia (DEPLOYMENTS.md), not a stubbed pair/APY string.
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
}

export async function proposeOpenPosition(riskTier: RiskTier, amount: number): Promise<OpenPositionResult> {
  const pool = RISK_POOLS[riskTier];
  // TODO: pool *selection* is still this hardcoded map, not a Claude Agent
  // SDK call — that needs its own ANTHROPIC_API_KEY (config.agent.model is
  // wired but unused). What's real below is the mint itself.
  console.log(`[agent] model=${config.agent.model} (not yet called) opening ${pool.pair} for ${amount} at risk=${riskTier}`);

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

  return { pair: pool.pair, apyBps: pool.baseApyBps, tokenId: tokenId.toString(), txHash };
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
