import { config } from "./config.js";
import type { RiskTier } from "./store.js";

/// PRD §7.9 — the agentic Uniswap v3/v4 yield manager, run on Claude Haiku
/// (`claude-haiku-4-5-20251001`) via the Claude Agent SDK. The agent
/// proposes; it never holds the treasury key (PRD §10). Phase 3 wires this
/// up to real tool calls (`getPoolState`, `proposeOpenPosition`,
/// `proposeRebalance`, `proposeExit`) against `ITakarabakoAgentController`
/// and the actual Uniswap v3 `NonfungiblePositionManager`.

const RISK_POOLS: Record<RiskTier, { pair: string; baseApyBps: number }> = {
  low: { pair: "USDC/ETH", baseApyBps: 320 },
  medium: { pair: "USDC/AAVE", baseApyBps: 610 },
  high: { pair: "USDC/DOGE", baseApyBps: 1450 },
};

export interface OpenPositionResult {
  pair: string;
  apyBps: number;
}

export async function proposeOpenPosition(riskTier: RiskTier, amount: number): Promise<OpenPositionResult> {
  const pool = RISK_POOLS[riskTier];
  // TODO(Phase 3): replace with a real Claude Agent SDK call —
  //   model: config.agent.model,
  //   tools: [getPoolState, proposeOpenPosition, proposeRebalance, proposeExit],
  // constrained to RISK_POOLS[riskTier] as the pool allow-list, with a hard
  // per-position spend cap before the backend co-signs and broadcasts.
  console.log(`[agent:stub] model=${config.agent.model} opening ${pool.pair} for ${amount} at risk=${riskTier}`);
  return { pair: pool.pair, apyBps: pool.baseApyBps };
}

export async function proposeExitAll(positions: { pair: string; amount: number; apyBps: number }[]) {
  // TODO(Phase 3): call proposeExit(positionId) per open position via
  // ITakarabakoAgentController, decreaseLiquidity + collect on-chain.
  const total = positions.reduce((sum, p) => sum + p.amount, 0);
  console.log(`[agent:stub] exiting ${positions.length} position(s), gross ${total}`);
  return { grossJpyc: total };
}
