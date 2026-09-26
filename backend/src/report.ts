import { concatHex, keccak256, stringToHex, toBytes, type Hex } from "viem";
import { pool } from "./db.js";
import { config } from "./config.js";
import { chainReady, sendTreasuryTx, treasuryAddress } from "./chain.js";
import { complete, llmReady } from "./llm.js";
import { reserveStatus, treasuryBalances, vaultState } from "./treasury.js";
import { checkAllKiosks, type IntegrityReport } from "./integrity.js";
import { mandateStatus } from "./mandate.js";
import { multibaasReady } from "./multibaas.js";

/// The agent's daily treasury report, made verifiable: the data and the
/// agent's write-up are serialised once (`canonical`), hashed with keccak256,
/// and the hash is anchored on Sepolia in a treasury self-transaction whose
/// calldata is "TKB-REPORT" + hash. Anyone can re-hash the published
/// canonical JSON and compare it with the transaction's input.

export const ANCHOR_PREFIX = "TKB-REPORT";
const DAY_MS = 86_400_000;

export interface AgentReport {
  id: string;
  body: string;
  canonical: string;
  hash: string;
  anchorTx: string | null;
  model: string | null;
  status: "clear" | "warn" | "critical";
  createdAt: Date;
}

const COLUMNS = `id, body, canonical, hash, anchor_tx as "anchorTx", model, status, created_at as "createdAt"`;

/// Anchor calldata: the prefix bytes followed by the 32-byte report hash.
export const anchorData = (hash: Hex): Hex => concatHex([stringToHex(ANCHOR_PREFIX), hash]);

/// The exact string that gets hashed. Keys are built in a fixed order, so
/// the same report always serialises (and hashes) the same way.
export function canonicalize(r: { version: 1; generatedAt: string; model: string; status: string; body: string; data: unknown }): string {
  return JSON.stringify({ version: r.version, generatedAt: r.generatedAt, model: r.model, status: r.status, body: r.body, data: r.data });
}

export const hashCanonical = (canonical: string): Hex => keccak256(toBytes(canonical));

const SYSTEM = `You are the treasury agent for Takarabako, a cash-in kiosk network on Ethereum Sepolia (customers insert banknotes; the treasury mints tkCASH, a claim on the cash in the kiosk's box, and deposits into a yield vault).
Write today's treasury report for the public proof-of-reserve page from the JSON you're given. Use only numbers in the data.
Style: plain English for a non-expert reader. Money as $1,234.56 (two decimals), ratios as 1.23×, APY as 4.2%. Never paste raw field names or long decimals.
Use exactly this Markdown structure, under 200 words:
**Status:** one sentence — all clear, or what needs attention.
### Reserves
One or two sentences: is every tkCASH backed by kiosk cash, and how well is the vault covered?
### Cash integrity
One bullet per kiosk: whether its signed notes, on-chain mints and physical count agree, and any problem in plain words.
### What I did
Actions the agent took on its own or proposed today, from the data — or "Nothing today."
### Watch next
One or two short, concrete bullets for operators.`;

async function gather() {
  const [vault, reserve, treasury, integrity, mandate, actions, alerts] = await Promise.all([
    vaultState().catch((e) => ({ error: String(e?.message ?? e) })),
    reserveStatus().catch((e) => ({ error: String(e?.message ?? e) })),
    treasuryBalances().catch((e) => ({ error: String(e?.message ?? e) })),
    checkAllKiosks().catch(() => [] as IntegrityReport[]),
    mandateStatus(),
    pool.query(
      `select action, args, status, autonomous, tx_hash as "txHash", created_at as at from ops_proposals where created_at > now() - interval '24 hours' order by created_at desc limit 20`,
    ),
    pool.query(`select rule, severity, message, created_at as at from ops_alerts where created_at > now() - interval '24 hours' order by created_at desc limit 20`),
  ]);
  return { vault, reserve, treasury, integrity, mandate, actions: actions.rows, alerts: alerts.rows };
}

export async function generateReport(): Promise<AgentReport> {
  if (!llmReady) throw new Error("AI_API_KEY is not set");
  if (!multibaasReady) throw new Error("MultiBaas is not configured");
  const data = await gather();
  const status = data.integrity.some((k) => k.status === "critical") ? "critical" : data.integrity.some((k) => k.status === "warn") ? "warn" : "clear";
  const body = await complete(SYSTEM, JSON.stringify(data), 3000);
  const generatedAt = new Date().toISOString();
  const canonical = canonicalize({ version: 1, generatedAt, model: config.ai.model, status, body, data });
  const hash = hashCanonical(canonical);

  let anchorTx: string | null = null;
  if (chainReady && treasuryAddress) {
    try {
      anchorTx = await sendTreasuryTx({ to: treasuryAddress, data: anchorData(hash), value: 0n });
    } catch (err) {
      console.error("[report] anchoring failed (report kept unanchored):", err instanceof Error ? err.message : err);
    }
  }
  const { rows } = await pool.query(
    `insert into agent_reports (id, body, canonical, hash, anchor_tx, model, status) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
    [crypto.randomUUID(), body, canonical, hash, anchorTx, config.ai.model, status],
  );
  return rows[0];
}

export async function listReports(limit = 14): Promise<Omit<AgentReport, "canonical">[]> {
  const { rows } = await pool.query(
    `select id, body, hash, anchor_tx as "anchorTx", model, status, created_at as "createdAt" from agent_reports order by created_at desc limit $1`,
    [limit],
  );
  return rows;
}

export async function getReport(id: string): Promise<AgentReport | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from agent_reports where id = $1`, [id]);
  return rows[0] ?? null;
}

/// One report a day: shortly after start if the last is over a day old,
/// then every 24 hours.
export function startDailyReports() {
  if (!config.opsAgent.dailyReports || !llmReady || !multibaasReady) return;
  const runIfDue = async () => {
    try {
      const { rows } = await pool.query("select created_at from agent_reports order by created_at desc limit 1");
      const last = rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : 0;
      if (Date.now() - last < DAY_MS - 60_000) return;
      const r = await generateReport();
      console.log(`[report] daily report ${r.id} (${r.status}) anchored in ${r.anchorTx ?? "(not anchored)"}`);
    } catch (err) {
      console.error("[report] daily report failed:", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(runIfDue, 90_000);
  setInterval(runIfDue, 60 * 60_000); // hourly check; generates once a day
}
