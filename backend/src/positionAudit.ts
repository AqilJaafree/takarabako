import { payoutStep } from "./closeFlow.js";

/// Sorts an unsettled Aqua position (status "open" or "closing") into what, if
/// anything, needs a person. A position settles only by being docked AND having
/// its payout sent and recorded; before the resumable close (closeFlow.ts), a
/// close that stopped halfway could leave strategies docked while the position
/// still said "open" and the customer was never paid.

export interface Balances {
  eth: bigint;
  usdc: bigint;
}

export type Finding =
  | { kind: "ok"; note: string }
  | { kind: "unreadable"; note: string }
  | { kind: "docked-but-open"; note: string }
  | { kind: "partly-docked"; note: string }
  | { kind: "closing-unpaid"; note: string }
  | { kind: "closing-in-doubt"; note: string }
  | { kind: "closing-sent"; note: string };

/// Findings a person has to act on (the others are fine or will clear themselves).
export const needsAttention = (f: Finding) => f.kind !== "ok" && f.kind !== "closing-sent";

const isDocked = (b: Balances) => b.eth === 0n && b.usdc === 0n;

/// `balances` has one entry per strategy, null where the read failed.
export function classifyPosition(p: { status: "open" | "closing"; closeTx: string | null; closeValue: number | null }, balances: Array<Balances | null>): Finding {
  if (p.status === "open") {
    if (balances.some((b) => b === null)) return { kind: "unreadable", note: "some strategy balances could not be read: run it again" };
    const docked = balances.filter((b) => b && isDocked(b)).length;
    if (docked === balances.length)
      return { kind: "docked-but-open", note: "every strategy is docked but the position is still open: its value was never paid out, and no payout amount is on record" };
    if (docked > 0)
      return { kind: "partly-docked", note: `${docked} of ${balances.length} strategies are docked: a close stopped halfway, so the customer's value is partly in the treasury unpaid` };
    return { kind: "ok", note: "open, every strategy holds balances" };
  }
  // closing: the payout is on record; where did the payout get to?
  const step = payoutStep(p.closeTx);
  if (step.kind === "send") return { kind: "closing-unpaid", note: `payout of $${p.closeValue ?? "?"} is on record but not sent: closing the position again will finish it` };
  if (step.kind === "blocked") return { kind: "closing-in-doubt", note: step.reason };
  return { kind: "closing-sent", note: "payout transaction recorded: closing again will verify it and finish" };
}
