/// Shapes of the backend's /dashboard/* and /ops/* responses (backend/src/routes/dashboard.ts, ops.ts).

export type Panel<T> = { data: T | null; error: string | null };

export type ChainKey = "sepolia" | "arc-testnet" | "hedera-testnet";
/// Which chains a view covers.
export type ChainFilter = "all" | ChainKey;

export interface VaultState {
  chain?: ChainKey;
  apyBps: number;
  totalShares: number;
  liabilityUsd: number;
  vaultUsdcBalance: number;
  reserveCoverage: number | null;
}

export interface KioskState {
  kioskId: string;
  active: boolean;
  frozen: boolean;
  reserve: number;
  lastAuditAt: number | null;
}

export interface Attestation {
  kioskId: string;
  counted: number;
  onChain: number;
  delta: number;
  at: string | null;
}

export type ReserveStatus =
  | { configured: false; chain?: ChainKey }
  | { configured: true; chain?: ChainKey; supply: number; reserve: number; paused: boolean; backed: boolean; kiosks: KioskState[]; attestations: Attestation[] };

/// The treasury on one chain. `usdc` is the ERC-20 view of the funds. Where the gas asset is USDC
/// (Arc) `native` is the same pool in its 18-decimal gas view: show `usdc`, never add the two.
export interface TreasuryBalances {
  chain?: ChainKey;
  address: string | null;
  nativeSymbol?: string;
  gasIsUsdc?: boolean;
  gasMin?: number;
  native?: number;
  eth: number;
  usdc?: number | null;
  musdc: number | null;
}

export type Severity = "critical" | "serious" | "warning" | "info";
export interface ActionItem {
  severity: Severity;
  title: string;
  detail: string;
}

export interface Alert {
  id: string;
  rule: string;
  severity: "info" | "warn" | "critical";
  message: string;
  createdAt: string;
}

export interface Proposal {
  id: string;
  action: "fund_yield_reserve" | "set_apy" | "pause_kiosk" | "mint_usdc_float" | "rebalance_chains";
  args: Record<string, unknown>;
  rationale: string;
  source: "ask" | "monitor";
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  txHash: string | null;
  error: string | null;
  autonomous?: boolean;
  createdAt: string;
}

export interface BridgeRow {
  id: string;
  kind: "customer" | "treasury";
  fromChain?: ChainKey;
  toChain?: ChainKey;
  from?: ChainKey;
  to?: ChainKey;
  amountUsd: number;
  state: "created" | "withdrawn" | "burned" | "attested" | "minted" | "credited" | "failed";
  burnTx?: string | null;
  mintTx?: string | null;
  creditTx?: string | null;
  error?: string | null;
  updatedAt: string;
}

export interface ChainSummary {
  chain: ChainKey;
  name: string;
  ready: boolean;
  vault: Panel<VaultState>;
  reserve: Panel<ReserveStatus>;
  treasury: Panel<TreasuryBalances>;
}

export interface IndexerStatus {
  chain: ChainKey;
  head: number | null;
  cursor: number | null;
  behind: number | null;
  live: boolean;
}

export interface Summary {
  multibaas: boolean;
  multibaasChain?: ChainKey;
  cashReceipt: boolean;
  kioskId: string;
  retiredKiosks?: string[];
  feeBps: number;
  chains: ChainSummary[];
  totals: { liabilityUsd: number; vaultUsdcBalance: number; tkcashSupply: number; tkcashReserve: number; treasuryUsdc: number };
  indexers: IndexerStatus[];
  bridge: { inFlight: number; recent: BridgeRow[] };
  vault: Panel<VaultState>;
  reserve: Panel<ReserveStatus>;
  treasury: Panel<TreasuryBalances>;
  actionItems: ActionItem[];
  alerts: Alert[];
  proposals: Proposal[];
}

export interface Holders {
  chains?: ChainKey[];
  tkcash: Panel<{
    total: number;
    count: number;
    top1Share: number;
    top3Share: number;
    holders: Array<{ address: string; balance: number; name: string | null; chains?: Record<string, number> }>;
  }>;
  vault: Panel<{ count: number; depositors: Array<{ address: string; deposited: number; name: string | null; chains?: Record<string, number> }> }>;
}

export interface Flows {
  chains?: ChainKey[];
  days: number;
  daily: Array<{ day: string; cashIn: number; cashOut: number; chains?: Record<string, { cashIn: number; cashOut: number }> }>;
  withdrawals: { gross: number; fees: number; count: number };
  denominations: Panel<Array<{ denomination: number; total: number }>>;
}

export interface Positions {
  chain?: ChainKey;
  chainName?: string;
  spot: number | null;
  aqua: string;
  router: string;
  tiers: Array<{
    mode: string;
    label: string;
    range: string;
    apyBps: number;
    open: number;
    strategies: number;
    amountUsd: number;
    valueUsd: number;
    inRange: number;
  }>;
}

export interface ChainEvent {
  id?: string;
  name: string;
  contractLabel: string | null;
  inputs: Record<string, string>;
  txHash: string | null;
  triggeredAt: string;
  chain?: ChainKey;
}

export interface BridgeOverview {
  inFlight: number;
  inFlightUsd: number;
  volume: Array<{ from: ChainKey; to: ChainKey; count: number; amountUsd: number }>;
  transfers: BridgeRow[];
}

export interface OpsData {
  chain: ChainFilter;
  bridge: BridgeOverview | { error: string };
  summary: Summary | { error: string };
  holders: Holders | { error: string };
  flows: Flows | { error: string };
  positions: Positions | { error: string };
  events: { source: string; events: ChainEvent[] } | { error: string };
  integrity: { kiosks: IntegrityReport[] } | { error: string };
  mandate: MandateStatus | { error: string };
  reports: { reports: AgentReportSummary[] } | { error: string };
  loadedAt: string;
}

/// Cash integrity (backend integrity.ts).
export interface IntegrityFinding {
  code: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
}

export interface IntegrityReport {
  kioskId: string;
  windowDays: number;
  status: "clear" | "warn" | "critical";
  machine: { notes: number; usd: number; unsigned: number };
  chain: { mints: number; usd: number; reserve: number | null; frozen: boolean };
  lastCount: { counted: number; onChain: number; delta: number; at: string | null } | null;
  notesSinceCount: number;
  findings: IntegrityFinding[];
  checkedAt: string;
}

/// The agent's mandate (backend mandate.ts).
export interface MandateStatus {
  enabled: boolean;
  rules: Array<{ action: Proposal["action"]; label: string; autonomous: boolean; dailyLimit: number | null; why: string; usedToday: number }>;
}

/// Daily reports (backend report.ts).
export interface AgentReportSummary {
  id: string;
  body: string;
  hash: string;
  anchorTx: string | null;
  model: string | null;
  status: "clear" | "warn" | "critical";
  createdAt: string;
}

export interface TraceStep {
  tool: string;
  input: unknown;
  output: unknown;
  error?: boolean;
}

export interface AgentRun {
  answer: string;
  trace: TraceStep[];
  proposalIds: string[];
  model: string;
}
