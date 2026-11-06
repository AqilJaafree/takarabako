// Read-only audit of unsettled Aqua positions: finds any that were left stuck
// (strategies docked but the customer never paid, or a close that stopped
// halfway) and shows where a "closing" payout got to. Sends nothing.
//
//   cd backend && npm run positions:audit
//
// Needs the database (docker compose up -d) and the chain RPC. Exits 1 if any
// position needs a person, so it can run in a check. To settle one: a
// "closing" position finishes by pressing Finish closing in the app (or
// closing it again); the others need a manual refund from the treasury.
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { strategyBalances } from "../src/aqua.js";
import { retryOnLag } from "../src/retry.js";
import { classifyPosition, needsAttention, type Balances } from "../src/positionAudit.js";

const QUERY = `select id, privy_user_id as "privyUserId", status, amount_usd::float as "amountUsd", close_value::float as "closeValue",
  close_tx as "closeTx", created_at as "createdAt", strategies
  from aqua_positions where status in ('open', 'closing') order by created_at`;

let rows: Array<{ id: string; privyUserId: string; status: "open" | "closing"; amountUsd: number; closeValue: number | null; closeTx: string | null; createdAt: Date; strategies: Array<{ hash: string }> }>;
try {
  rows = (await pool.query(QUERY)).rows;
} catch (err) {
  const reason = (err as { code?: string })?.code ?? (err instanceof Error ? err.message : String(err));
  console.error(`cannot read the database (${reason}). Start it with: cd backend && docker compose up -d`);
  process.exit(2);
}

console.log(`${config.network.name} · ${rows.length} unsettled position${rows.length === 1 ? "" : "s"}\n`);
let attention = 0;
for (const p of rows) {
  const balances: Array<Balances | null> = [];
  for (const s of p.strategies) balances.push(await retryOnLag(() => strategyBalances(s.hash)).catch(() => null));
  const f = classifyPosition(p, balances);
  if (needsAttention(f)) attention++;
  console.log(`${needsAttention(f) ? "✗" : "✓"} ${p.id}  ${p.status.padEnd(7)} $${p.amountUsd}  user ${p.privyUserId.slice(0, 14)}…  ${p.createdAt.toISOString().slice(0, 10)}\n    ${f.kind}: ${f.note}`);
}
console.log(attention ? `\n${attention} position${attention === 1 ? "" : "s"} need a person.` : "\nNothing is stuck.");
await pool.end();
process.exit(attention ? 1 : 0);
