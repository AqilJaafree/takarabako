// Shapes returned by the Express backend's /self/arc/* routes
// (backend/src/routes/selfRoutes.ts, selfPositions.ts).

/// What a position is: one of the advanced shapes over a price range, or the full range.
export type SelfShape = "full" | "spot" | "curve" | "bidask" | "hybrid";
export type SelfMode = SelfShape;

export interface SelfWallet {
  /// The pair these balances are for, and the base token the wallet holds in every pair on the chain.
  pair?: string;
  pairs?: Array<{ pair: string; symbols: { base: string; quote: string }; base: number; stable: boolean }>;
  address: string;
  usdc: number;
  weth: number;
  /// USDC available for network fees (Arc's gas token). Same as `gas` on Arc.
  gasUsdc: number;
  /// The chain's native coin available for network fees, and its name (USDC on Arc, ETH on Sepolia).
  gas?: number;
  gasSymbol?: string;
  /// What the two tokens are called on this chain (WETH/USDC on Arc, mETH/mUSDC on Sepolia).
  symbols?: { base: string; quote: string };
  /// Who holds the tokens while a position is open: "contract" (a position manager) or "wallet".
  custody?: "contract" | "wallet";
  maxUsd: number;
}

export interface SelfStep {
  to: string;
  data: string;
  description: string;
  chainId: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface SelfPrepared {
  positionId: string;
  steps: SelfStep[];
  summary?: { spot: number; usdc: string; weth: string; strategies: number };
}

export interface SelfPosition {
  id: string;
  /// Which pair it is in, and what its tokens are called.
  pair?: string;
  symbols?: { base: string; quote: string };
  /// The wallet that owns the position: the one that has to sign to close it.
  wallet: string;
  /// The position manager contract holding the tokens, or null when the wallet itself does.
  manager?: string | null;
  status: "open" | "closed" | "pending";
  /// Signing stopped partway: some strategies are live in Aqua and can be closed, the rest never opened.
  partial?: boolean;
  mode: SelfMode;
  amountUsd: number;
  spotOpen: number;
  priceMin: number | null;
  priceMax: number | null;
  strategies: number;
  weth: number;
  usdc: number;
  valueUsd: number | null;
  openTxs: string[] | null;
  closeTxs: string[] | null;
  createdAt: string;
}

/// GET /self/:net/dashout — what selling the wallet's leftover base token for USDC through Aqua would get now.
export interface DashOutQuote {
  pair?: string;
  symbols: { base: string; quote: string };
  /// The wallet's base-token balance, and how much of it would be sold.
  balance: number;
  amountIn: number;
  amountOut: number;
  /// Base token no open strategy could take.
  unfilled: number;
  /// USDC per base token the strategies pay, the market's, and how far below it (%).
  rate: number | null;
  marketRate: number | null;
  discountPct: number | null;
  /// False when the price is too far below the market (or cannot be checked): then it cannot be prepared.
  allowed: boolean;
  reason: string | null;
  strategies: number;
  maxDiscountPct: number;
}

/// POST /self/:net/dashout/prepare
export interface DashOutPrepared {
  steps: SelfStep[];
  quote: DashOutQuote;
  /// The least USDC the swaps will accept: the quote less the slippage allowance.
  minOut: number;
}

/// GET /self/:net/market?pair= — the pair's checked price, the range limits and (where there is a feed) candles.
export interface SelfMarket {
  pair: string;
  symbols: { base: string; quote: string };
  stable: boolean;
  spot: number;
  candles: Array<{ t: number; o: number; h: number; l: number; c: number }>;
  advanced: { minPrice: number; maxPrice: number; feeBps: number; bins: number };
}
