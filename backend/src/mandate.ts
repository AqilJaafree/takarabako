import { pool } from "./db.js";
import { config } from "./config.js";
import type { ProposalAction } from "./policy.js";

/// The treasury agent's mandate: what it may do on its own, within daily
/// limits, without waiting for a human. Everything else — and anything past
/// a limit — is filed as a proposal for an operator to approve. The hard
/// limits in policy.ts still apply on top of this; the mandate is the
/// narrower band inside them where the agent acts by itself.

export interface MandateRule {
  action: ProposalAction;
  label: string;
  autonomous: boolean;
  dailyLimit: number | null; // USDC per UTC day, for amount actions
  why: string;
}

export const MANDATE: MandateRule[] = [
  { action: "pause_kiosk", label: "Pause a kiosk", autonomous: true, dailyLimit: null, why: "Only stops new cash coming in; a human unpauses." },
  { action: "fund_yield_reserve", label: "Top up the yield reserve", autonomous: true, dailyLimit: 100, why: "Keeps interest payable; larger top-ups need a human." },
  { action: "mint_usdc_float", label: "Mint mUSDC float", autonomous: true, dailyLimit: 2000, why: "Keeps deposits flowing; larger mints need a human." },
  { action: "set_apy", label: "Change the vault APY", autonomous: false, dailyLimit: null, why: "Changes every depositor's return — always a human decision." },
];

export type MandateCheck = { autonomous: true } | { autonomous: false; reason: string };

/// Pure: would this action fit the mandate, given what the agent already did
/// on its own today?
export function checkMandate(action: ProposalAction, args: Record<string, unknown>, usedToday: Partial<Record<ProposalAction, number>>, enabled = config.opsAgent.autonomy): MandateCheck {
  if (!enabled) return { autonomous: false, reason: "autonomy is switched off (AGENT_AUTONOMY=off)" };
  const rule = MANDATE.find((r) => r.action === action);
  if (!rule || !rule.autonomous) return { autonomous: false, reason: `${rule?.label ?? action} always needs a human` };
  if (rule.dailyLimit !== null) {
    const amount = Number(args.amount);
    const used = usedToday[action] ?? 0;
    if (!Number.isFinite(amount) || used + amount > rule.dailyLimit) {
      return { autonomous: false, reason: `over the agent's own limit of ${rule.dailyLimit} USDC a day (${used} used today)` };
    }
  }
  return { autonomous: true };
}

/// What the agent executed on its own today (UTC), per action.
export async function mandateUsage(): Promise<Partial<Record<ProposalAction, number>>> {
  const { rows } = await pool.query(
    `select action, count(*)::int as n, coalesce(sum((args->>'amount')::numeric), 0)::float as total
       from ops_proposals
      where autonomous and status = 'executed'
        and decided_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
      group by action`,
  );
  const out: Partial<Record<ProposalAction, number>> = {};
  for (const r of rows) out[r.action as ProposalAction] = r.action === "pause_kiosk" ? r.n : r.total;
  return out;
}

export async function mandateStatus() {
  const used = await mandateUsage();
  return {
    enabled: config.opsAgent.autonomy,
    rules: MANDATE.map((r) => ({ ...r, usedToday: used[r.action] ?? 0 })),
  };
}
