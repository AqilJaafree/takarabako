/// Closing an Aqua position is three steps that must not lose or repeat money:
///   1. claim it (open -> closing) and record the payout, before anything moves;
///   2. dock its strategies, skipping any already docked;
///   3. send the payout to the customer's vault exactly once, then mark closed.
/// A failure after step 1 leaves the position "closing" with its payout on
/// record, and closing it again picks up where it stopped. The payout
/// transaction is tracked in close_tx: null (not sent), "pending" (about to
/// be sent: nothing was recorded, so an automatic retry could pay twice and
/// is refused), or the transaction hash.

export type PayoutStep =
  | { kind: "send" }
  | { kind: "verify"; hash: `0x${string}` }
  | { kind: "blocked"; reason: string };

export const PAYOUT_PENDING = "pending";

export function payoutStep(closeTx: string | null): PayoutStep {
  if (closeTx === null) return { kind: "send" };
  if (/^0x[0-9a-fA-F]{64}$/.test(closeTx)) return { kind: "verify", hash: closeTx as `0x${string}` };
  if (closeTx === PAYOUT_PENDING)
    return {
      kind: "blocked",
      reason: "this position's payout was started but its transaction was not recorded, so paying again could pay twice: check the treasury's transactions for it first",
    };
  return { kind: "blocked", reason: `unexpected payout record "${closeTx}": check this position by hand` };
}

/// A USD amount rounded down to the micro-dollar a 6-decimal USDC can hold.
export const floorMicros = (usd: number): number => Math.max(0, Math.floor(usd * 1e6) / 1e6);
