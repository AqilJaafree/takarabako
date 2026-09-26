import { keccak256, toBytes, getAddress } from "viem";

/// In-memory store for withdraw events. Accounts, sessions, deposits and
/// yield positions live in Postgres, so a restart doesn't forget them.

export interface WithdrawEvent {
  id: string;
  privyUserId: string;
  grossUsdc: number;
  feeBps: number;
  netUsdc: number;
  ts: number;
}

const withdrawEvents: WithdrawEvent[] = [];

/// Deterministic address derived from the Privy user id — valid,
/// checksummed, stable across restarts, but not one anyone holds the key
/// to. That's fine: only the treasury ever moves vault shares for it
/// (onlyOwner in TakarabakoVault.sol), so this is purely a bookkeeping key
/// on-chain. The user's own real wallet (Privy) is tracked separately.
export function deriveBoundAddress(privyUserId: string): string {
  return getAddress(`0x${keccak256(toBytes(privyUserId)).slice(-40)}`);
}

export const store = {
  logWithdraw(event: WithdrawEvent) {
    withdrawEvents.push(event);
  },
};
