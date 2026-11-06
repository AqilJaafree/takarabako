// Shapes returned by the Express backend's /self/arc/* routes
// (backend/src/routes/selfRoutes.ts, selfPositions.ts).

export type SelfMode = "low" | "medium" | "high" | "hybrid";

export interface SelfWallet {
  address: string;
  usdc: number;
  weth: number;
  /// USDC available for network fees (Arc's gas token).
  gasUsdc: number;
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
  /// The wallet that is the Aqua maker: the one that has to sign to close it.
  wallet: string;
  status: "open" | "closed";
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
