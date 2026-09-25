import { keccak256, toBytes, getAddress } from "viem";

/// In-memory store for what hasn't moved to Postgres yet: Uniswap position
/// records and withdraw events. Accounts, sessions and deposits live in
/// Postgres (accounts.ts, sessions.ts), so a restart doesn't forget them.

export type RiskTier = "low" | "medium" | "high";

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

export interface WithdrawEvent {
  id: string;
  privyUserId: string;
  grossUsdc: number;
  feeBps: number;
  netUsdc: number;
  ts: number;
}

const positionsByUser = new Map<string, Position[]>();
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

  logWithdraw(event: WithdrawEvent) {
    withdrawEvents.push(event);
  },
};
