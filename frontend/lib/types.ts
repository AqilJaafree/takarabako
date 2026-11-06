// Shapes returned by the Express backend (backend/src/routes/*). Shared by
// server components, route handlers and client components.

export type RiskTier = "low" | "medium" | "high";

/// The cash chains Takarabako runs on (backend config CASH_CHAIN_KEYS).
export type ChainKey = "sepolia" | "arc-testnet" | "hedera-testnet";

export interface Position {
  positionId: string;
  name: string; // short tag, e.g. aqua-1a2b3c4d
  riskTier: RiskTier; // for the 3D box's gems (advanced counts as high)
  mode: RiskTier | "advanced";
  shape: Shape;
  pair: string;
  label: string;
  amount: number; // live value, USD
  apyBps: number; // estimate
  inRange: boolean | null;
  priceMin: number | null;
  priceMax: number | null;
}

export type Shape = "full" | "spot" | "curve" | "bidask" | "hybrid";

/// GET /me
export interface Me {
  userId: string;
  label: string | null;
  privyWallet: string;
  balance: number; // total across chains
  balances: ChainBalance[];
  apyBps: number;
  positions: Position[];
  limit?: DailyLimit;
  expiresAt: string;
}

/// The customer's box on one chain.
export interface ChainBalance {
  chain: ChainKey;
  name: string;
  chainId: number;
  balance: number;
  apyBps: number;
}

/// What an account may still move today (the same limit for everyone).
export interface DailyLimit {
  limited: boolean;
  limitUsd: number;
  usedUsd: number;
  leftUsd: number | null; // null when there's no limit
}

/// GET /deposits
export interface Deposit {
  id: string;
  currency: string;
  amount: number;
  usdAmount: number | null;
  txHash: string | null;
  tkcashTxHash?: string | null; // the tkCASH receipt token minted for this note
  machineName?: string | null; // the kiosk that took it, when its signature checked out
  machineVerified?: boolean;
  chain?: ChainKey;
  status: "queued" | "sending" | "confirmed" | "failed";
  attempts: number;
  error: string | null;
  createdAt: string;
}

/// GET /me/cash-receipts — the customer's tkCASH and its backing.
export type CashReceipts =
  | { configured: false; chain?: ChainKey }
  | {
      configured: true;
      chain?: ChainKey;
      contract: string;
      wallet: string;
      balance: number;
      kiosk: { kioskId: string; reserve: number; active: boolean; frozen: boolean; lastAuditAt: number | null };
      supply: number;
      reserve: number;
      backed: boolean;
    };

/// GET /me/cash-receipts without ?chain= : the primary chain's fields plus every chain.
export type CashReceiptsAll = CashReceipts & { chains?: CashReceipts[]; totalBalance?: number };

/// GET /agent/pools
export interface Pool {
  riskTier: RiskTier;
  label: string;
  description: string;
  pair: string;
  apyBps: number; // estimate
  feeBps: number;
  fullRange: boolean;
  rangePct: number | null;
  priceLowUsd: number | null;
  priceHighUsd: number | null;
}

/// GET /yield/market
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Market {
  spot: number;
  candles: Candle[];
  tiers: Pool[];
  advanced: { minPrice: number; maxPrice: number; feeBps: number; apyEstBps: number; bins: number };
  /// Absent on an older backend, which means: show the estimates, no real money.
  showEstimates?: boolean;
  realMoney?: boolean;
  network?: { key: string; name: string; explorerUrl: string };
}

/// POST /yield/preview
export interface PreviewBin {
  min: number | null;
  max: number | null;
  weight: number;
  usd: number;
  eth: number;
  usdc: number;
}

export interface Preview {
  spot: number;
  side: "usdc" | "eth" | "both";
  bins: PreviewBin[];
}

/// GET /yield/positions (one entry)
export interface PositionView {
  id: string;
  mode: RiskTier | "advanced";
  shape: Shape;
  label: string;
  priceMin: number | null;
  priceMax: number | null;
  spotOpen: number;
  amountUsd: number;
  apyEstBps: number;
  rationale: string | null;
  /// "closing" = a close that stopped halfway; closing it again finishes it.
  status: "open" | "closing" | "closed";
  valueUsd: number | null;
  pnlUsd: number | null;
  inRange: boolean | null;
  spot: number;
  eth: number;
  usdc: number;
  bins: Array<{ min: number | null; max: number | null; weight: number; eth: number; usdc: number; valueUsd: number }>;
  createdAt: string;
  closedAt: string | null;
  closeValue: number | null;
}

/// POST /agent/open-position
export interface OpenedPosition {
  positionId: string;
  name: string;
  pair: string;
  apyBps: number;
  nftTokenId: string | null;
  txHash: string | null;
  rationale: string | null;
}

/// POST /withdraw
export interface WithdrawResult {
  positionsClosed: number;
  vaultTxHash: string;
  grossUsdc: number;
  feeBps: number;
  netUsdc: number;
  destination: "cash" | "wallet";
  receipt: string;
  tkcashBurned?: number;
  tkcashTxHash?: string | null;
  legs?: Array<{ chain: ChainKey; txHash: string | null; grossUsdc: number; netUsdc: number; tkcashBurned: number }>;
}

/// Live events from GET /events/stream (backend/src/events.ts).
export type LiveEvent =
  | { type: "deposit.pending"; depositId: string; amount: number; currency: string; estUsd: number | null; ts: number }
  | { type: "deposit.retrying"; depositId: string; attempt: number; maxAttempts: number; error: string; ts: number }
  | {
      type: "deposit.confirmed";
      depositId: string;
      amount: number;
      currency: string;
      usdAmount: number;
      fxRate: number;
      txHash: string;
      balance: number;
      chain?: ChainKey;
      ts: number;
    }
  | { type: "deposit.failed"; depositId: string; amount: number; currency: string; error: string; ts: number }
  | { type: "deposit.refused"; reason: "unsupported" | "bad_condition"; sessionId: string | null; ts: number }
  | { type: "tkcash.minted"; depositId: string; amount: number; txHash: string; chain?: ChainKey; ts: number }
  | { type: "bridge.update"; transferId: string; state: BridgeState; fromChain: ChainKey; toChain: ChainKey; amount: number; ts: number };

/// A deposit session's receipt (backend history.ts).
export interface ReceiptNote {
  id: string;
  amount: number;
  currency: string;
  usdAmount: number | null;
  txHash: string | null;
  tkcashTxHash?: string | null;
  machineName?: string | null;
  machineVerified?: boolean;
  chain?: ChainKey;
  status: "queued" | "sending" | "confirmed" | "failed";
  at: string;
}

export interface Receipt {
  id: string;
  status: "open" | "finished";
  startedAt: string;
  finishedAt: string | null;
  notes: ReceiptNote[];
  totalAmount: number;
  currency: string;
  totalUsdConfirmed: number;
  settled: boolean;
}

export type HistoryItem =
  | ({ kind: "deposit_session"; at: string } & Receipt)
  | {
      kind: "withdrawal";
      at: string;
      id: string;
      destination: "cash" | "wallet";
      grossUsd: number;
      feeBps: number;
      netUsd: number;
      txHash: string | null;
      tkcashBurned?: number;
      tkcashTxHash?: string | null;
      chain?: ChainKey;
    }
  | {
      kind: "yield";
      at: string;
      id: string;
      action: "open" | "close";
      riskTier: string | null;
      pair: string | null;
      apyBps: number | null;
      amountUsd: number | null;
      rationale: string | null;
      label: string | null;
      txHash: string | null;
    }
  | { kind: "refused"; at: string; id: string; reason: "unsupported" | "bad_condition" | "no_session"; sessionId: string | null }
  | {
      kind: "transfer";
      at: string;
      id: string;
      asset: "balance" | "tkcash";
      direction: "sent" | "received";
      counterparty: string | null;
      amountUsd: number | null;
      positionId: string | null;
      chain?: ChainKey;
      txHash: string | null;
    };

/// GET /lookup?q=
export interface ResolvedRecipient {
  query: string;
  address: string;
  label: string | null;
  customer: boolean;
  tkcashAllowlisted: boolean | null;
}

/// GET /me/wallet — the customer's own wallet on each chain.
export interface MyWallet {
  label: string | null;
  wallet: string;
  chains: Array<{
    chain: ChainKey;
    name: string;
    chainId: number;
    nativeSymbol: string;
    native: number | null;
    tkcash: { balance: number; allowlisted: boolean; dailyLimit: number | null; spentToday: number } | null;
  }>;
  limit?: DailyLimit;
}

/// CCTP bridge (backend bridge.ts).
export type BridgeState = "created" | "withdrawn" | "burned" | "attested" | "minted" | "credited" | "failed";

export interface BridgeTransfer {
  id: string;
  kind: "customer" | "treasury";
  fromChain: ChainKey;
  toChain: ChainKey;
  amountUsd: number;
  state: BridgeState;
  withdrawTx: string | null;
  burnTx: string | null;
  mintTx: string | null;
  creditTx: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  explorers: { from: string; to: string };
}

/// POST /bridge/quote
export interface BridgeQuote {
  from: ChainKey;
  to: ChainKey;
  amount: number;
  feeUsd: number;
  receiveUsd: number;
  availableOnSource: number;
  enough: boolean;
  estimatedMinutes: number;
  maxUsd: number;
}

/// What a kiosk login hands the browser. The backend session token stays in
/// the httpOnly cookie; the browser only gets what it displays.
export interface KioskLogin {
  label: string | null;
  balance: number;
  scope: "full" | "deposit";
  expiresAt: string;
  qrFallback: string | null;
  qrEmailed: boolean;
  bridge: "ok" | "skipped" | "failed";
  depositSessionId: string | null;
  limit: DailyLimit | null; // what's left of today's limit
  depositBlocked: string | null; // why a deposit couldn't start (e.g. today's limit is used)
}
