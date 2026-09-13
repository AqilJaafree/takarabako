import { keccak256, toBytes, getAddress } from "viem";

/// In-memory store for the hackathon build. PRD §9 data model.
/// Phase 1 (done): `depositOnChain`/`withdrawAllOnChain` (chain.ts) read and
/// write real vault state keyed by `Wallet.boundAddress` below. Still local:
/// the event log and the Uniswap-position records — those move to a small
/// Postgres/SQLite table whenever Phase 3 makes them real.

export type RiskTier = "low" | "medium" | "high";

export interface User {
  privyUserId: string; // PK — Privy's user id, our sybil-resistance signal (one email -> one Privy user)
  handle: string;
  boundAddress: string; // deterministic bookkeeping address the treasury moves vault/position funds for
  privyWalletAddress: string; // the user's real embedded wallet (Privy), for reference/future use
  ensName: string;
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
  privyUserId: string | null;
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

export interface Wallet {
  handle: string;
  ensName: string;
  boundAddress: string;
  idleBalance: number; // USDC not yet routed into a position
  privyUserId: string | null; // set once §6.2 signup/login binds a human
}

const usersByPrivyId = new Map<string, User>();
const walletsByHandle = new Map<string, Wallet>();
const positionsByUser = new Map<string, Position[]>();
const depositEvents: DepositEvent[] = [];
const withdrawEvents: WithdrawEvent[] = [];

let nextPositionId = 1;

export const store = {
  users: usersByPrivyId,

  createUser(user: User) {
    usersByPrivyId.set(user.privyUserId, user);
  },

  getUser(privyUserId: string): User | undefined {
    return usersByPrivyId.get(privyUserId);
  },

  getOrCreateWallet(handle: string, ensName: string): Wallet {
    const existing = walletsByHandle.get(handle);
    if (existing) return existing;
    const wallet: Wallet = {
      handle,
      ensName,
      // Deterministic address derived from the handle — valid, checksummed,
      // and stable across restarts, but not one anyone holds the key to.
      // That's fine: only the treasury ever moves vault shares for it
      // (onlyOwner in TakarabakoVault.sol), so this is purely a bookkeeping
      // key on-chain. The user's own real wallet (Privy) is tracked
      // separately on the User record once they verify.
      boundAddress: getAddress(`0x${keccak256(toBytes(handle)).slice(-40)}`),
      idleBalance: 0,
      privyUserId: null,
    };
    walletsByHandle.set(handle, wallet);
    return wallet;
  },

  getWallet(handle: string): Wallet | undefined {
    return walletsByHandle.get(handle);
  },

  bindWalletToUser(handle: string, privyUserId: string) {
    const wallet = walletsByHandle.get(handle);
    if (wallet) wallet.privyUserId = privyUserId;
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
