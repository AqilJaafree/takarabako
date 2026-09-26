import { Router } from "express";
import { config } from "../config.js";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";
import { LABELS, mbCall, mbEvents, mbQuery, multibaasReady } from "../multibaas.js";
import { cashReceiptReady, fromTkUnits } from "../cashReceipt.js";
import { reserveStatus, treasuryBalances, vaultState } from "../treasury.js";
import { recentEvents } from "../chainEvents.js";
import { listProposals, recentAlerts } from "../proposals.js";
import { getTiersInfo } from "../agent.js";
import { ethUsd, openPositions, viewPosition } from "../aqua.js";
import { ADVANCED } from "../aquaMath.js";

/// GET /dashboard/* — the operator dashboard's data (Curvegrid Digital Asset
/// Dashboard track). Contract state comes from MultiBaas reads, holdings and
/// mixes from saved MultiBaas Event Queries, daily flows from the events the
/// MultiBaas webhook streamed into Postgres. The MultiBaas key stays here —
/// the browser only ever sees these aggregates.
export const dashboardRouter = Router();

// The free tier allows 30k MultiBaas calls a month; a dashboard left open
// would burn through that, so each panel is cached briefly.
const CACHE_MS = 20_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/// A panel that fails reports its error instead of breaking the whole page.
async function safely<T>(load: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await load(), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

type Severity = "critical" | "serious" | "warning" | "info";
interface ActionItem {
  severity: Severity;
  title: string;
  detail: string;
}

const THRESHOLDS = { treasuryEth: 0.05, reserveCoverage: 1.2 } as const;

dashboardRouter.get("/dashboard/summary", asyncHandler(async (_req, res) => {
  const body = await cached("summary", async () => {
    const [vault, reserve, treasury, proposals] = await Promise.all([
      safely(vaultState),
      safely(reserveStatus),
      safely(treasuryBalances),
      listProposals(20),
    ]);

    const items: ActionItem[] = [];
    if (treasury.data && treasury.data.eth < THRESHOLDS.treasuryEth)
      items.push({
        severity: "critical",
        title: "Treasury is low on Sepolia ETH",
        detail: `${treasury.data.eth.toFixed(4)} ETH left; every deposit costs gas. Top up ${treasury.data.address} from a faucet.`,
      });
    const coverage = vault.data?.reserveCoverage;
    if (coverage != null && coverage < THRESHOLDS.reserveCoverage)
      items.push({
        severity: coverage < 1 ? "critical" : "warning",
        title: "Yield reserve is thin",
        detail: `The vault holds ${coverage.toFixed(2)}× what it owes depositors (target ${THRESHOLDS.reserveCoverage}×).`,
      });
    if (reserve.data?.configured) {
      if (!reserve.data.backed)
        items.push({
          severity: "critical",
          title: "tkCASH supply doesn't match the cash reserve",
          detail: `Supply ${reserve.data.supply.toFixed(2)} vs reserve ${reserve.data.reserve.toFixed(2)}.`,
        });
      if (reserve.data.paused) items.push({ severity: "serious", title: "tkCASH is paused", detail: "Transfers and cash-ins are stopped." });
      for (const k of reserve.data.kiosks) {
        if (k.frozen)
          items.push({ severity: "critical", title: `Kiosk ${k.kioskId} is frozen`, detail: "Its last count didn't match the chain. Recount, then unfreeze." });
        else if (!k.active) items.push({ severity: "serious", title: `Kiosk ${k.kioskId} is out of service`, detail: "It won't take cash until reactivated." });
      }
    }
    const pending = proposals.filter((p) => p.status === "pending");
    if (pending.length)
      items.push({
        severity: "info",
        title: `${pending.length} agent proposal${pending.length === 1 ? "" : "s"} awaiting approval`,
        detail: pending.map((p) => p.action.replaceAll("_", " ")).join(", "),
      });

    return {
      multibaas: multibaasReady,
      cashReceipt: cashReceiptReady,
      kioskId: config.kioskId,
      feeBps: config.withdrawFeeBps,
      vault,
      reserve,
      treasury,
      actionItems: items,
      alerts: await recentAlerts(10),
      proposals,
    };
  });
  res.json(body);
}));

/// Wallet → customer name (their ENS subname), from our own accounts table.
async function namesFor(addresses: string[], column: "privy_wallet" | "bound_address") {
  if (!addresses.length) return new Map<string, string>();
  const { rows } = await pool.query(
    `select lower(${column}) as addr, ens_name from accounts where lower(${column}) = any($1)`,
    [addresses.map((a) => a.toLowerCase())],
  );
  return new Map<string, string>(rows.map((r) => [r.addr, r.ens_name]));
}

const ZERO = "0x0000000000000000000000000000000000000000";

dashboardRouter.get("/dashboard/holders", asyncHandler(async (_req, res) => {
  res.json(
    await cached("holders", async () => {
      const tkcash = await safely(async () => {
        const rows = await mbQuery<{ holder: string; balance: string }>("tkcash_holders", 500);
        const holders = rows
          .filter((r) => r.holder && r.holder.toLowerCase() !== ZERO)
          .map((r) => ({ address: r.holder, balance: fromTkUnits(String(r.balance).split(".")[0] ?? "0") }))
          .filter((h) => h.balance > 0)
          .sort((a, b) => b.balance - a.balance);
        const names = await namesFor(holders.map((h) => h.address), "privy_wallet");
        const total = holders.reduce((s, h) => s + h.balance, 0);
        return {
          total,
          count: holders.length,
          top1Share: total ? (holders[0]?.balance ?? 0) / total : 0,
          top3Share: total ? holders.slice(0, 3).reduce((s, h) => s + h.balance, 0) / total : 0,
          holders: holders.slice(0, 10).map((h) => ({ ...h, name: names.get(h.address.toLowerCase()) ?? null })),
        };
      });
      const vault = await safely(async () => {
        const rows = await mbQuery<{ user: string; total: string }>("deposits_by_user", 500);
        const depositors = rows
          .map((r) => ({ address: r.user, deposited: Number(String(r.total).split(".")[0]) / 1e6 }))
          .sort((a, b) => b.deposited - a.deposited);
        const names = await namesFor(depositors.map((d) => d.address), "bound_address");
        return {
          count: depositors.length,
          depositors: depositors.slice(0, 10).map((d) => ({ ...d, name: names.get(d.address.toLowerCase()) ?? null })),
        };
      });
      return { tkcash, vault };
    }),
  );
}));

const DAYS = 14;

dashboardRouter.get("/dashboard/flows", asyncHandler(async (_req, res) => {
  res.json(
    await cached("flows", async () => {
      // Daily cash in/out of the kiosk (tkCASH CashIn/CashOut) from the
      // webhook log, and withdrawal fees from our own records.
      const { rows: daily } = await pool.query(
        `with days as (
           select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day
         )
         select to_char(d.day, 'YYYY-MM-DD') as day,
           coalesce(sum(case when e.name = 'CashIn' then (e.inputs->>'amount')::numeric end), 0)::float / 1e6 as "cashIn",
           coalesce(sum(case when e.name = 'CashOut' then (e.inputs->>'amount')::numeric end), 0)::float / 1e6 as "cashOut"
         from days d
         left join chain_events e on e.triggered_at::date = d.day and e.contract_label = $2 and e.name in ('CashIn', 'CashOut')
         group by d.day order by d.day`,
        [DAYS, LABELS.cashReceipt],
      );
      const { rows: [fees] } = await pool.query(
        `select coalesce(sum(gross_usd), 0)::float as gross, coalesce(sum(gross_usd - net_usd), 0)::float as fees, count(*)::int as count
         from withdrawals where created_at > now() - make_interval(days => $1)`,
        [DAYS],
      );
      const denominations = await safely(async () => {
        const rows = await mbQuery<{ denomination: string; total: string }>("cash_in_by_denomination", 100);
        return rows
          .map((r) => ({ denomination: Number(r.denomination), total: Number(String(r.total).split(".")[0]) / 1e6 }))
          .sort((a, b) => a.denomination - b.denomination);
      });
      return { days: DAYS, daily, withdrawals: fees, denominations };
    }),
  );
}));

dashboardRouter.get("/dashboard/positions", asyncHandler(async (_req, res) => {
  res.json(
    await cached("positions", async () => {
      // 1inch Aqua strategies the treasury has shipped, by tier, valued live.
      const [open, spot] = await Promise.all([openPositions(), ethUsd().catch(() => null)]);
      const views = spot ? await Promise.all(open.map((p) => viewPosition(p, spot).catch(() => null))) : [];
      const modes = ["low", "medium", "high", "advanced"] as const;
      const tiers = modes.map((mode) => {
        const mine = views.filter((v): v is NonNullable<typeof v> => v !== null && v.mode === mode);
        const info = getTiersInfo(spot).find((t) => t.riskTier === mode);
        return {
          mode,
          label: mode === "advanced" ? "Advanced" : info?.label ?? mode,
          range: mode === "advanced" ? "custom" : info?.fullRange ? "full range" : `±${info?.rangePct}%`,
          apyBps: mode === "advanced" ? ADVANCED.apyEstBps : info?.apyBps ?? 0,
          open: mine.length,
          strategies: mine.reduce((s, v) => s + v.bins.length, 0),
          amountUsd: mine.reduce((s, v) => s + v.amountUsd, 0),
          valueUsd: mine.reduce((s, v) => s + (v.valueUsd ?? 0), 0),
          inRange: mine.filter((v) => v.inRange).length,
        };
      });
      return { spot, aqua: config.aqua.address, router: config.aqua.router, tiers };
    }),
  );
}));

dashboardRouter.get("/dashboard/events", asyncHandler(async (_req, res) => {
  const stored = await recentEvents(40);
  if (stored.length || !multibaasReady) {
    res.json({ source: "webhook", events: stored });
    return;
  }
  // Nothing streamed in yet (no webhook): read MultiBaas's index directly.
  const events = await cached("events", () => mbEvents({ limit: 40 })).catch(() => []);
  res.json({ source: "multibaas", events });
}));
