import { onChainEvent, type StoredEvent } from "./chainEvents.js";
import { raiseAlert } from "./proposals.js";
import { askOpsAgent, investigateKiosk, opsAgentReady } from "./opsAgent.js";
import { LABELS } from "./multibaas.js";
import { checkKiosk } from "./integrity.js";
import { decodeKiosk } from "./treasury.js";

/// Watches the events MultiBaas streams in (routes/webhooks.ts) with a few
/// fixed rules. A rule that fires raises an alert on the dashboard; a
/// serious one also wakes the ops agent for a one-shot look, which can file
/// a proposal for a human to approve. Every cash event also re-runs the
/// kiosk's cash-integrity check (integrity.ts); a new critical finding gets
/// the agent to investigate — and pause the kiosk, within its mandate.

export const RULES = {
  largeCashInUsd: 500, // one note worth more than this is unusual at a kiosk
  withdrawalBurst: { count: 3, windowMs: 10 * 60_000 },
  agentCooldownMs: 60_000, // at most one automatic agent run a minute
} as const;

const USD = 1e6;
const signedUsd = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
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
        message: `Reserve count mismatch: physical count differs from the chain by ${signedUsd(delta)} — that kiosk's minting is frozen`,
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
  seenFindings.clear();
}

// A finding is raised once per kiosk until it changes (e.g. a new count).
const seenFindings = new Map<string, string>();
const CASH_EVENTS = new Set(["CashIn", "CashOut", "ReserveAttested", "KioskFrozen"]);

async function checkIntegrityAfter(e: StoredEvent) {
  const kioskId = decodeKiosk(e.inputs.kioskId);
  if (!kioskId) return;
  const report = await checkKiosk(kioskId);
  const fresh = report.findings.filter((f) => {
    const key = `${kioskId}:${f.code}`;
    if (seenFindings.get(key) === f.detail) return false;
    seenFindings.set(key, f.detail);
    return true;
  });
  for (const f of fresh) {
    await raiseAlert({ rule: `integrity_${f.code}`, severity: f.severity === "critical" ? "critical" : f.severity === "warn" ? "warn" : "info", message: `${kioskId}: ${f.title}. ${f.detail}`, eventId: e.id });
  }
  if (!fresh.some((f) => f.severity === "critical") || !opsAgentReady || Date.now() - lastAgentRun < RULES.agentCooldownMs) return;
  lastAgentRun = Date.now();
  const run = await investigateKiosk(report, "monitor");
  await raiseAlert({ rule: "integrity_agent", severity: "info", message: `Agent (${kioskId}): ${run.answer}`, eventId: e.id });
}

export function startOpsMonitor() {
  onChainEvent(async (e) => {
    for (const f of evaluate(e)) {
      await raiseAlert({ rule: f.rule, severity: f.severity, message: f.message, eventId: e.id });
      // A count mismatch is investigated with the integrity report below.
      if (f.rule === "reserve_mismatch") continue;
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
    if (e.contractLabel === LABELS.cashReceipt && CASH_EVENTS.has(e.name)) {
      // In the background: the webhook must answer MultiBaas quickly.
      void checkIntegrityAfter(e).catch((err) => console.error("[ops-monitor] integrity check failed:", err instanceof Error ? err.message : err));
    }
  });
}
