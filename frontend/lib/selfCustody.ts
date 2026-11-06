// Shapes returned by the Express backend's /self/arc/* routes
// (backend/src/routes/selfRoutes.ts, selfPositions.ts).

/// What a position is: one of the advanced shapes over a price range, or the full range.
export type SelfShape = "full" | "spot" | "curve" | "bidask" | "hybrid";
export type SelfMode = SelfShape;

export interface SelfWallet {
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
