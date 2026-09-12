import { keccak256, toBytes, getAddress } from "viem";

/// In-memory store for the hackathon build. PRD §9 data model.
/// Phase 1 (done): `depositOnChain`/`withdrawAllOnChain` (chain.ts) read and
/// write real vault state keyed by `Wallet.boundAddress` below. Still local:
/// the event log and the Uniswap-position records — those move to a small
/// Postgres/SQLite table whenever Phase 3 makes them real.

export type RiskTier = "low" | "medium" | "high";

export interface User {
  worldIdNullifier: string; // PK
  handle: string;
  boundAddress: string;
  ensName: string;
  createdAt: number;
}

export interface Position {
  positionId: number;
  ensName: string;
  user: string; // worldIdNullifier
  riskTier: RiskTier;
  pair: string;
  amount: number; // USDC principal, demo units
  apyBps: number;
  openedAt: number;
  nftTokenId?: string; // real Uniswap v3 position NFT id, once minted (chain.ts)
}

export interface DepositEvent {
  id: string;
  nullifier: string | null;
  denomination: number;
  txHash: string;
  ts: number;
}

export interface WithdrawEvent {
  id: string;
  nullifier: string;
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
  nullifier: string | null; // set once §6.2 signup/login binds a human
}

const usersByNullifier = new Map<string, User>();
const walletsByHandle = new Map<string, Wallet>();
const positionsByUser = new Map<string, Position[]>();
const depositEvents: DepositEvent[] = [];
const withdrawEvents: WithdrawEvent[] = [];

let nextPositionId = 1;

export const store = {
  users: usersByNullifier,

  createUser(user: User) {
    usersByNullifier.set(user.worldIdNullifier, user);
  },

  getUser(nullifier: string): User | undefined {
    return usersByNullifier.get(nullifier);
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
      // key on-chain. Phase 1+ swaps this for a real generated/derived
      // signer or smart-account address once the box needs the user to
      // hold their own key.
      boundAddress: getAddress(`0x${keccak256(toBytes(handle)).slice(-40)}`),
      idleBalance: 0,
      nullifier: null,
    };
    walletsByHandle.set(handle, wallet);
    return wallet;
  },

  getWallet(handle: string): Wallet | undefined {
    return walletsByHandle.get(handle);
  },

  bindWalletToNullifier(handle: string, nullifier: string) {
    const wallet = walletsByHandle.get(handle);
    if (wallet) wallet.nullifier = nullifier;
  },

  addPosition(position: Omit<Position, "positionId">): Position {
    const full: Position = { ...position, positionId: nextPositionId++ };
    const existing = positionsByUser.get(position.user) ?? [];
    existing.push(full);
    positionsByUser.set(position.user, existing);
    return full;
  },

  getPositions(nullifier: string): Position[] {
    return positionsByUser.get(nullifier) ?? [];
  },

  clearPositions(nullifier: string) {
    positionsByUser.set(nullifier, []);
  },

  logDeposit(event: DepositEvent) {
    depositEvents.push(event);
  },

  logWithdraw(event: WithdrawEvent) {
    withdrawEvents.push(event);
  },
};
