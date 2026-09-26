import { pool } from "./db.js";
import { config } from "./config.js";
import { checkPolicy, type PolicyContext, type ProposalAction } from "./policy.js";
import { checkMandate, mandateUsage } from "./mandate.js";

/// The ops agent's proposals: created pending (only if policy allows),
/// executed only when a human approves. Execution goes through MultiBaas.

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface Proposal {
  id: string;
  action: ProposalAction;
  args: Record<string, unknown>;
  rationale: string;
  source: "ask" | "monitor";
  status: ProposalStatus;
  txHash: string | null;
  error: string | null;
  autonomous: boolean;
  createdAt: Date;
  decidedAt: Date | null;
}

const COLUMNS = `id, action, args, rationale, source, status, tx_hash as "txHash", error, autonomous,
  created_at as "createdAt", decided_at as "decidedAt"`;

/// Amounts of each action committed today (UTC). When filing, pending
/// proposals count too, so the agent can't queue several that each fit the
/// daily cap alone; at approval only what was actually executed counts.
export async function policyContext(opts: { includePending?: boolean } = {}): Promise<PolicyContext> {
  const { rows } = await pool.query(
    `select action, coalesce(sum((args->>'amount')::numeric), 0)::float as total
     from ops_proposals
     where (status = 'executed' and decided_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        or ($1 and status = 'pending')
     group by action`,
    [opts.includePending ?? false],
  );
  const total = (a: string) => rows.find((r) => r.action === a)?.total ?? 0;
  return { fundedToday: total("fund_yield_reserve"), mintedToday: total("mint_usdc_float"), knownKiosks: [config.kioskId, ...config.previousKioskIds] };
}

export type CreateResult = { ok: true; proposal: Proposal; mandate?: string } | { ok: false; reason: string };

/// Files a proposal if policy allows. With `execute`, an action inside the
/// agent's mandate (mandate.ts) is carried out at once and marked
/// autonomous; anything else waits for a human, with the reason.
export async function createProposal(p: {
  action: ProposalAction;
  args: Record<string, unknown>;
  rationale: string;
  source?: "ask" | "monitor";
  execute?: Executor;
}): Promise<CreateResult> {
  const check = checkPolicy(p.action, p.args, await policyContext({ includePending: true }));
  if (!check.ok) return check;
  const { rows } = await pool.query(
    `insert into ops_proposals (id, action, args, rationale, source) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [crypto.randomUUID(), p.action, JSON.stringify(p.args), p.rationale, p.source ?? "ask"],
  );
  const proposal: Proposal = rows[0];
  if (!p.execute) return { ok: true, proposal };

  const mandate = checkMandate(p.action, p.args, await mandateUsage());
  if (!mandate.autonomous) return { ok: true, proposal, mandate: mandate.reason };
  await pool.query("update ops_proposals set autonomous = true where id = $1", [proposal.id]);
  const done = await approveProposal(proposal.id, p.execute);
  return done.ok ? { ok: true, proposal: done.proposal } : { ok: true, proposal: (await getProposal(proposal.id))!, mandate: done.error };
}

export async function listProposals(limit = 50): Promise<Proposal[]> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from ops_proposals order by (status = 'pending') desc, created_at desc limit $1`,
    [limit],
  );
  return rows;
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from ops_proposals where id = $1`, [id]);
  return rows[0] ?? null;
}

/// Carries out an approved action on-chain and returns the tx hash.
export type Executor = (action: ProposalAction, args: Record<string, unknown>) => Promise<string>;

export type DecideResult = { ok: true; proposal: Proposal } | { ok: false; status: number; error: string };

/// A human approved: re-check policy, claim the proposal (so two clicks
/// can't execute it twice), execute, and record the outcome.
export async function approveProposal(id: string, execute: Executor): Promise<DecideResult> {
  const proposal = await getProposal(id);
  if (!proposal) return { ok: false, status: 404, error: "no such proposal" };
  if (proposal.status !== "pending") return { ok: false, status: 409, error: `proposal is already ${proposal.status}` };

  const check = checkPolicy(proposal.action, proposal.args, await policyContext());
  if (!check.ok) {
    await pool.query("update ops_proposals set status = 'rejected', error = $2, decided_at = now() where id = $1", [id, check.reason]);
    return { ok: false, status: 422, error: `no longer within policy: ${check.reason}` };
  }

  const claimed = await pool.query(
    "update ops_proposals set status = 'approved', decided_at = now() where id = $1 and status = 'pending'",
    [id],
  );
  if (!claimed.rowCount) return { ok: false, status: 409, error: "proposal was decided meanwhile" };

  try {
    const txHash = await execute(proposal.action, proposal.args);
    await pool.query("update ops_proposals set status = 'executed', tx_hash = $2 where id = $1", [id, txHash]);
  } catch (err) {
    await pool.query("update ops_proposals set status = 'failed', error = $2 where id = $1", [
      id,
      err instanceof Error ? err.message : String(err),
    ]);
  }
  return { ok: true, proposal: (await getProposal(id))! };
}

export async function rejectProposal(id: string, note?: string): Promise<DecideResult> {
  const { rowCount } = await pool.query(
    "update ops_proposals set status = 'rejected', error = $2, decided_at = now() where id = $1 and status = 'pending'",
    [id, note ?? null],
  );
  if (!rowCount) {
    const existing = await getProposal(id);
    return existing
      ? { ok: false, status: 409, error: `proposal is already ${existing.status}` }
      : { ok: false, status: 404, error: "no such proposal" };
  }
  return { ok: true, proposal: (await getProposal(id))! };
}

// ---- alerts --------------------------------------------------------------

export interface Alert {
  id: string;
  rule: string;
  severity: "info" | "warn" | "critical";
  message: string;
  eventId: string | null;
  createdAt: Date;
}

export async function raiseAlert(a: Omit<Alert, "id" | "createdAt">): Promise<Alert> {
  const { rows } = await pool.query(
    `insert into ops_alerts (id, rule, severity, message, event_id) values ($1, $2, $3, $4, $5)
     returning id, rule, severity, message, event_id as "eventId", created_at as "createdAt"`,
    [crypto.randomUUID(), a.rule, a.severity, a.message, a.eventId],
  );
  return rows[0];
}

export async function recentAlerts(limit = 20): Promise<Alert[]> {
  const { rows } = await pool.query(
    `select id, rule, severity, message, event_id as "eventId", created_at as "createdAt"
     from ops_alerts order by created_at desc limit $1`,
    [limit],
  );
  return rows;
}
