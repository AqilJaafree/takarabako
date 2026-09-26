import { onChainEvent, type StoredEvent } from "./chainEvents.js";
import { raiseAlert } from "./proposals.js";
import { askOpsAgent, opsAgentReady } from "./opsAgent.js";
import { LABELS } from "./multibaas.js";

/// Watches the events MultiBaas streams in (routes/webhooks.ts) with a few
/// fixed rules. A rule that fires raises an alert on the dashboard; a
/// serious one also wakes the ops agent for a one-shot look, which can file
/// a proposal for a human to approve.

export const RULES = {
  largeCashInUsd: 500, // one note worth more than this is unusual at a kiosk
  withdrawalBurst: { count: 3, windowMs: 10 * 60_000 },
  agentCooldownMs: 60_000, // at most one automatic agent run a minute
} as const;

const USD = 1e6;
let recentWithdrawals: number[] = [];
let lastAgentRun = 0;

export type Finding = { rule: string; severity: "info" | "warn" | "critical"; message: string; wakeAgent: boolean };

/// Pure rule evaluation, so it can be tested without a database.
export function evaluate(e: StoredEvent, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  if (e.contractLabel === LABELS.cashReceipt && e.name === "CashIn") {
    const usd = Number(e.inputs.amount ?? 0) / USD;
    if (usd > RULES.largeCashInUsd)
      out.push({ rule: "large_cash_in", severity: "warn", message: `Large cash-in: $${usd.toFixed(2)} in one note (tx ${e.txHash})`, wakeAgent: false });
  }
  if (e.contractLabel === LABELS.cashReceipt && e.name === "ReserveAttested") {
    const delta = Number(e.inputs.delta ?? 0) / USD;
    if (delta !== 0)
      out.push({
        rule: "reserve_mismatch",
        severity: "critical",
        message: `Reserve count mismatch: physical count differs from the chain by $${delta.toFixed(2)} — that kiosk's minting is frozen`,
        wakeAgent: true,
      });
  }
  if (e.contractLabel === LABELS.vault && e.name === "Withdrawn") {
    recentWithdrawals = [...recentWithdrawals.filter((t) => now - t < RULES.withdrawalBurst.windowMs), now];
    if (recentWithdrawals.length >= RULES.withdrawalBurst.count)
      out.push({
        rule: "withdrawal_burst",
        severity: "warn",
        message: `${recentWithdrawals.length} withdrawals in the last ${RULES.withdrawalBurst.windowMs / 60_000} minutes`,
        wakeAgent: true,
      });
  }
  return out;
}

export function resetMonitor() {
  recentWithdrawals = [];
  lastAgentRun = 0;
}

export function startOpsMonitor() {
  onChainEvent(async (e) => {
    for (const f of evaluate(e)) {
      await raiseAlert({ rule: f.rule, severity: f.severity, message: f.message, eventId: e.id });
      if (!f.wakeAgent || !opsAgentReady || Date.now() - lastAgentRun < RULES.agentCooldownMs) continue;
      lastAgentRun = Date.now();
      // In the background: the webhook must answer MultiBaas quickly.
      void askOpsAgent(
        `Automatic alert (${f.rule}): ${f.message}. Check the relevant state, then either file the proposal an operator should review or explain why none is needed.`,
        "monitor",
      )
        .then((run) => raiseAlert({ rule: `${f.rule}_agent`, severity: "info", message: `Agent: ${run.answer}`, eventId: e.id }))
        .catch((err) => console.error("[ops-monitor] agent run failed:", err instanceof Error ? err.message : err));
    }
  });
}
