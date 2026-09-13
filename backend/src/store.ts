import { keccak256, toBytes, getAddress } from "viem";

/// In-memory store for the hackathon build. PRD §9 data model.
/// ATM-style flow (§6.1/§6.2 swapped): identity comes first now — /verify
/// creates the Account, /deposit just credits it — so there's no more
/// separate per-box "handle"/"Wallet" concept sitting ahead of identity.
/// One Account per Privy user, keyed by `privyUserId`.
///
/// Phase 1 (done): `depositOnChain`/`withdrawAllOnChain` (chain.ts) read and
/// write real vault state keyed by `Account.boundAddress` below. Still
/// local: the event log and the Uniswap-position records — those move to a
/// small Postgres/SQLite table whenever Phase 3 makes them real.

export type RiskTier = "low" | "medium" | "high";

export interface Account {
  privyUserId: string; // PK — Privy's user id, our sybil-resistance signal (one email -> one Privy user)
  ensName: string;
  boundAddress: string; // deterministic bookkeeping address the treasury moves vault/position funds for
  privyWalletAddress: string; // the user's real embedded wallet (Privy), for reference/future use
  idleBalance: number; // USDC not yet routed into a position
  createdAt: number;
}

export interface Position {
  positionId: number;
  ensName: string;
  user: string; // privyUserId
  riskTier: RiskTier;
  pair: string;
  amount: number; // USDC principal, demo units
  apyBps: number;
  openedAt: number;
  nftTokenId?: string; // real Uniswap v3 position NFT id, once minted (chain.ts)
}

export interface DepositEvent {
  id: string;
  privyUserId: string;
  denomination: number;
  txHash: string;
  ts: number;
}

export interface WithdrawEvent {
  id: string;
  privyUserId: string;
  grossUsdc: number;
  feeBps: number;
  netUsdc: number;
  ts: number;
}

const accountsByPrivyId = new Map<string, Account>();
const positionsByUser = new Map<string, Position[]>();
const depositEvents: DepositEvent[] = [];
const withdrawEvents: WithdrawEvent[] = [];

let nextPositionId = 1;

/// Deterministic address derived from the Privy user id — valid,
/// checksummed, stable across restarts, but not one anyone holds the key
/// to. That's fine: only the treasury ever moves vault shares for it
/// (onlyOwner in TakarabakoVault.sol), so this is purely a bookkeeping key
/// on-chain. The user's own real wallet (Privy) is tracked separately.
export function deriveBoundAddress(privyUserId: string): string {
  return getAddress(`0x${keccak256(toBytes(privyUserId)).slice(-40)}`);
}

export const store = {
  accounts: accountsByPrivyId,

  createAccount(account: Account) {
    accountsByPrivyId.set(account.privyUserId, account);
  },

  getAccount(privyUserId: string): Account | undefined {
    return accountsByPrivyId.get(privyUserId);
  },

  addPosition(position: Omit<Position, "positionId">): Position {
    const full: Position = { ...position, positionId: nextPositionId++ };
    const existing = positionsByUser.get(position.user) ?? [];
    existing.push(full);
    positionsByUser.set(position.user, existing);
    return full;
  },

  getPositions(privyUserId: string): Position[] {
    return positionsByUser.get(privyUserId) ?? [];
  },

  clearPositions(privyUserId: string) {
    positionsByUser.set(privyUserId, []);
  },

  logDeposit(event: DepositEvent) {
    depositEvents.push(event);
  },

  logWithdraw(event: WithdrawEvent) {
    withdrawEvents.push(event);
  },
};
