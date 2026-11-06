import { Router } from "express";
import { config, isCashChain, type CashChainKey } from "../config.js";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";
import { LABELS, mbEvents, mbQuery, multibaasReady } from "../multibaas.js";
import { cashReceiptReadyOn, fromTkUnits } from "../cashReceipt.js";
import { indexerStatus } from "../logIndexer.js";
import { listTransfers } from "../bridge.js";
import { chainOps } from "../chain.js";
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


/// Which chains a request covers: ?chain=sepolia | arc-testnet | all (default all).
function chainsFor(q: unknown): CashChainKey[] {
  const c = typeof q === "string" ? q : "all";
  if (c === "all" || !c) return [...config.enabledChains];
  if (!isCashChain(c) || !config.enabledChains.includes(c)) throw Object.assign(new Error(`unknown or disabled chain "${c}"`), { status: 400 });
  return [c];
}
const chainLabel = (k: CashChainKey) => config.chains[k].network.name;
/// MultiBaas serves the primary chain only (when configured); everything else is read from the event log.
const viaMb = (k: CashChainKey) => multibaasReady && k === config.defaultChain;

type Severity = "critical" | "serious" | "warning" | "info";
interface ActionItem {
  severity: Severity;
  title: string;
  detail: string;
}

const THRESHOLDS = { reserveCoverage: 1.2 } as const;

dashboardRouter.get("/dashboard/summary", asyncHandler(async (req, res) => {
  const chains = chainsFor(req.query.chain);
  const body = await cached(`summary:${chains.join(",")}`, async () => {
    const perChain = await Promise.all(
      chains.map(async (chain) => {
        const [vault, reserve, treasury] = await Promise.all([
          safely(() => vaultState(chain)),
          safely(() => reserveStatus(chain)),
          safely(() => treasuryBalances(chain)),
        ]);
        return { chain, name: chainLabel(chain), ready: chainOps(chain).chainReady, vault, reserve, treasury };
      }),
    );
    const [proposals, transfers, indexers] = await Promise.all([listProposals(20), listTransfers({ limit: 20 }), indexerStatus()]);

    const items: ActionItem[] = [];
    for (const c of perChain) {
      const net = config.chains[c.chain].network;
      if (!c.ready) {
        items.push({ severity: "serious", title: `${c.name} isn't configured`, detail: "Set its treasury key, USDC and vault addresses in backend/.env." });
        continue;
      }
      const t = c.treasury.data;
      // On Arc the gas asset is USDC (the same funds as the float), so its one figure is judged once.
      if (t && t.native < config.chains[c.chain].network.gas.treasuryMin)
        items.push({
          severity: "critical",
          title: `Treasury is low on ${c.name} gas (${net.nativeSymbol})`,
          detail: `${t.native.toFixed(4)} ${net.nativeSymbol} left; every deposit costs gas. Top up ${t.address} from a faucet.`,
        });
      const coverage = c.vault.data?.reserveCoverage;
      if (coverage != null && coverage < THRESHOLDS.reserveCoverage)
        items.push({
          severity: coverage < 1 ? "critical" : "warning",
          title: `${c.name}: yield reserve is thin`,
          detail: `The vault holds ${coverage.toFixed(2)}× what it owes depositors (target ${THRESHOLDS.reserveCoverage}×).`,
        });
      const r = c.reserve.data;
      if (r?.configured) {
        if (!r.backed)
          items.push({ severity: "critical", title: `${c.name}: tkCASH supply doesn't match the cash reserve`, detail: `Supply ${r.supply.toFixed(2)} vs reserve ${r.reserve.toFixed(2)}.` });
        if (r.paused) items.push({ severity: "serious", title: `${c.name}: tkCASH is paused`, detail: "Transfers and cash-ins are stopped." });
        for (const k of r.kiosks) {
          // Retired kiosks (KIOSK_PREVIOUS_IDS) are out of service on purpose.
          if (config.previousKioskIds.includes(k.kioskId)) continue;
          if (k.frozen)
            items.push({ severity: "critical", title: `${c.name}: kiosk ${k.kioskId} is frozen`, detail: "Its last count didn't match the chain. Recount, then unfreeze." });
          else if (!k.active) items.push({ severity: "serious", title: `${c.name}: kiosk ${k.kioskId} is out of service`, detail: "It won't take cash until reactivated." });
        }
      }
    }
    for (const i of indexers) {
      if (chains.includes(i.chain) && i.behind !== null && i.behind > 500)
        items.push({ severity: "warning", title: `${chainLabel(i.chain)} event log is catching up`, detail: `${i.behind.toLocaleString("en-US")} blocks behind the chain head; figures built from events may lag.` });
    }
    const stuck = transfers.filter((t) => t.state !== "credited" && t.state !== "failed" && !(t.kind === "treasury" && t.state === "minted") && Date.now() - t.updatedAt.getTime() > 45 * 60_000);
    if (stuck.length)
      items.push({ severity: "serious", title: `${stuck.length} bridge transfer${stuck.length === 1 ? "" : "s"} taking unusually long`, detail: stuck.map((t) => `${t.fromChain} to ${t.toChain}, $${t.amountUsd} (${t.state})`).join("; ") });
    const pending = proposals.filter((p) => p.status === "pending");
    if (pending.length)
      items.push({
        severity: "info",
        title: `${pending.length} agent proposal${pending.length === 1 ? "" : "s"} awaiting approval`,
        detail: pending.map((p) => p.action.replaceAll("_", " ")).join(", "),
      });

    // Totals across the selected chains. Treasury USDC is the ERC-20 view only: on Arc the
    // native gas balance is the same pool of funds and is never added in.
    const sum = (pick: (c: (typeof perChain)[number]) => number | null | undefined) => perChain.reduce((s, c) => s + (pick(c) ?? 0), 0);
    const totals = {
      liabilityUsd: sum((c) => c.vault.data?.liabilityUsd),
      vaultUsdcBalance: sum((c) => c.vault.data?.vaultUsdcBalance),
      tkcashSupply: sum((c) => (c.reserve.data?.configured ? c.reserve.data.supply : 0)),
      tkcashReserve: sum((c) => (c.reserve.data?.configured ? c.reserve.data.reserve : 0)),
      treasuryUsdc: sum((c) => c.treasury.data?.usdc),
    };
    const primary = perChain.find((c) => c.chain === config.defaultChain) ?? perChain[0];

    return {
      multibaas: multibaasReady,
      multibaasChain: config.defaultChain,
      cashReceipt: perChain.some((c) => cashReceiptReadyOn(c.chain)),
      kioskId: config.kioskId,
      retiredKiosks: config.previousKioskIds,
      feeBps: config.withdrawFeeBps,
      chains: perChain,
      totals,
      indexers,
      bridge: {
        inFlight: transfers.filter((t) => t.state !== "credited" && t.state !== "failed" && !(t.kind === "treasury" && t.state === "minted")).length,
        recent: transfers.slice(0, 8),
      },
      // The primary chain's panels, kept at the top level for older clients.
      vault: primary?.vault,
      reserve: primary?.reserve,
      treasury: primary?.treasury,
      actionItems: items,
      alerts: await recentAlerts(10),
      proposals,
    };
  });
  res.json(body);
}));

/// Wallet → customer name (their label), from our own accounts table.
async function namesFor(addresses: string[], column: "privy_wallet" | "bound_address") {
  if (!addresses.length) return new Map<string, string>();
  const { rows } = await pool.query(
    `select lower(${column}) as addr, label from accounts where lower(${column}) = any($1)`,
    [addresses.map((a) => a.toLowerCase())],
  );
  return new Map<string, string>(rows.map((r) => [r.addr, r.label]));
}

const ZERO = "0x0000000000000000000000000000000000000000";

/// tkCASH balances rebuilt from Transfer events in the event log, per holder, for the chains asked for.
async function tkcashHoldersFromEvents(chains: CashChainKey[]) {
  const { rows } = await pool.query<{ holder: string; chain: string; balance: string }>(
    `select holder, chain, sum(delta)::text as balance from (
       select lower(inputs->>'to') as holder, chain, (inputs->>'value')::numeric as delta
         from chain_events where name = 'Transfer' and contract_label = $1 and chain = any($2)
       union all
       select lower(inputs->>'from') as holder, chain, -(inputs->>'value')::numeric as delta
         from chain_events where name = 'Transfer' and contract_label = $1 and chain = any($2)
     ) t group by holder, chain`,
    [LABELS.cashReceipt, chains],
  );
  return rows.map((r) => ({ holder: r.holder, chain: r.chain as CashChainKey, balance: r.balance }));
}

/// Vault deposits per depositor, from Deposited events.
async function depositsFromEvents(chains: CashChainKey[]) {
  const { rows } = await pool.query<{ user: string; chain: string; total: string }>(
    `select lower(inputs->>'user') as "user", chain, sum((inputs->>'usdcAmount')::numeric)::text as total
       from chain_events where name = 'Deposited' and contract_label = $1 and chain = any($2) group by 1, 2`,
    [LABELS.vault, chains],
  );
  return rows.map((r) => ({ user: r.user, chain: r.chain as CashChainKey, total: r.total }));
}

dashboardRouter.get("/dashboard/holders", asyncHandler(async (req, res) => {
  const chains = chainsFor(req.query.chain);
  res.json(
    await cached(`holders:${chains.join(",")}`, async () => {
      const tkcash = await safely(async () => {
        // The primary chain through its saved MultiBaas query, the others from the event log.
        const fromMb = chains.filter(viaMb);
        const fromLog = chains.filter((c) => !viaMb(c));
        const rows: Array<{ holder: string; chain: CashChainKey; balance: string }> = [];
        if (fromMb.length) {
          const q = await mbQuery<{ holder: string; balance: string }>("tkcash_holders", 500);
          rows.push(...q.map((r) => ({ holder: r.holder, chain: fromMb[0]!, balance: String(r.balance).split(".")[0] ?? "0" })));
        }
        if (fromLog.length) rows.push(...(await tkcashHoldersFromEvents(fromLog)));
        // One line per wallet, summed across chains, remembering where it holds tkCASH.
        const byWallet = new Map<string, { address: string; balance: number; chains: Record<string, number> }>();
        for (const r of rows) {
          if (!r.holder || r.holder.toLowerCase() === ZERO) continue;
          const key = r.holder.toLowerCase();
          const amount = fromTkUnits(r.balance.split(".")[0] ?? "0");
          const w = byWallet.get(key) ?? { address: r.holder, balance: 0, chains: {} };
          w.balance += amount;
          w.chains[r.chain] = (w.chains[r.chain] ?? 0) + amount;
          byWallet.set(key, w);
        }
        const holders = [...byWallet.values()].filter((h) => h.balance > 1e-9).sort((a, b) => b.balance - a.balance);
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
        const rows: Array<{ user: string; chain: CashChainKey; total: string }> = [];
        const fromMb = chains.filter(viaMb);
        const fromLog = chains.filter((c) => !viaMb(c));
        if (fromMb.length) {
          const q = await mbQuery<{ user: string; total: string }>("deposits_by_user", 500);
          rows.push(...q.map((r) => ({ user: r.user, chain: fromMb[0]!, total: String(r.total).split(".")[0] ?? "0" })));
        }
        if (fromLog.length) rows.push(...(await depositsFromEvents(fromLog)));
        const byUser = new Map<string, { address: string; deposited: number; chains: Record<string, number> }>();
        for (const r of rows) {
          const key = r.user.toLowerCase();
          const amount = Number(r.total.split(".")[0]) / 1e6;
          const d = byUser.get(key) ?? { address: r.user, deposited: 0, chains: {} };
          d.deposited += amount;
          d.chains[r.chain] = (d.chains[r.chain] ?? 0) + amount;
          byUser.set(key, d);
        }
        const depositors = [...byUser.values()].sort((a, b) => b.deposited - a.deposited);
        const names = await namesFor(depositors.map((d) => d.address), "bound_address");
        return {
          count: depositors.length,
          depositors: depositors.slice(0, 10).map((d) => ({ ...d, name: names.get(d.address.toLowerCase()) ?? null })),
        };
      });
      return { chains, tkcash, vault };
    }),
  );
}));

const DAYS = 14;

dashboardRouter.get("/dashboard/flows", asyncHandler(async (req, res) => {
  const chains = chainsFor(req.query.chain);
  res.json(
    await cached(`flows:${chains.join(",")}`, async () => {
      // Daily cash in/out of the kiosks (tkCASH CashIn/CashOut) from the event
      // log, split by chain, and withdrawal fees from our own records.
      const { rows: dayRows } = await pool.query(
        `with days as (
           select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day
         )
         select to_char(d.day, 'YYYY-MM-DD') as day, e.chain,
           coalesce(sum(case when e.name = 'CashIn' then (e.inputs->>'amount')::numeric end), 0)::float / 1e6 as "cashIn",
           coalesce(sum(case when e.name = 'CashOut' then (e.inputs->>'amount')::numeric end), 0)::float / 1e6 as "cashOut"
         from days d
         left join chain_events e on e.triggered_at::date = d.day and e.contract_label = $2 and e.name in ('CashIn', 'CashOut') and e.chain = any($3)
         group by d.day, e.chain order by d.day`,
        [DAYS, LABELS.cashReceipt, chains],
      );
      const byDay = new Map<string, { day: string; cashIn: number; cashOut: number; chains: Record<string, { cashIn: number; cashOut: number }> }>();
      for (const r of dayRows) {
        const d = byDay.get(r.day) ?? { day: r.day, cashIn: 0, cashOut: 0, chains: {} as Record<string, { cashIn: number; cashOut: number }> };
        d.cashIn += r.cashIn;
        d.cashOut += r.cashOut;
        if (r.chain) d.chains[r.chain] = { cashIn: r.cashIn, cashOut: r.cashOut };
        byDay.set(r.day, d);
      }
      const daily = [...byDay.values()];
      const { rows: [fees] } = await pool.query(
        `select coalesce(sum(gross_usd), 0)::float as gross, coalesce(sum(gross_usd - net_usd), 0)::float as fees, count(*)::int as count
         from withdrawals where created_at > now() - make_interval(days => $1) and chain = any($2)`,
        [DAYS, chains],
      );
      const denominations = await safely(async () => {
        const { rows } = await pool.query<{ denomination: string; total: string }>(
          `select inputs->>'denomination' as denomination, sum((inputs->>'amount')::numeric)::text as total
             from chain_events where name = 'CashIn' and contract_label = $1 and chain = any($2) group by 1`,
          [LABELS.cashReceipt, chains],
        );
        if (rows.length || !chains.some(viaMb)) {
          return rows.map((r) => ({ denomination: Number(r.denomination), total: Number(r.total) / 1e6 })).sort((a, b) => a.denomination - b.denomination);
        }
        // Nothing streamed in yet: the primary chain's saved MultiBaas query.
        const q = await mbQuery<{ denomination: string; total: string }>("cash_in_by_denomination", 100);
        return q
          .map((r) => ({ denomination: Number(r.denomination), total: Number(String(r.total).split(".")[0]) / 1e6 }))
          .sort((a, b) => a.denomination - b.denomination);
      });
      return { chains, days: DAYS, daily, withdrawals: fees, denominations };
    }),
  );
}));

/// CCTP transfers between the chains: what is moving, what finished, and the volume each way.
dashboardRouter.get("/dashboard/bridge", asyncHandler(async (_req, res) => {
  res.json(
    await cached("bridge", async () => {
      const [recent, { rows: volume }] = await Promise.all([
        listTransfers({ limit: 20 }),
        pool.query(
          `select from_chain as "from", to_chain as "to", count(*)::int as count, coalesce(sum(amount_usd), 0)::float as "amountUsd"
             from bridge_transfers where state <> 'failed' and created_at > now() - interval '14 days' group by 1, 2 order by 1, 2`,
        ),
      ]);
      const active = (t: (typeof recent)[number]) => t.state !== "credited" && t.state !== "failed" && !(t.kind === "treasury" && t.state === "minted");
      return {
        inFlight: recent.filter(active).length,
        inFlightUsd: recent.filter(active).reduce((s, t) => s + t.amountUsd, 0),
        volume,
        transfers: recent.map((t) => ({
          id: t.id,
          kind: t.kind,
          from: t.fromChain,
          to: t.toChain,
          amountUsd: t.amountUsd,
          state: t.state,
          burnTx: t.burnTx,
          mintTx: t.mintTx,
          creditTx: t.creditTx,
          error: t.state === "failed" ? t.error : null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      };
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
      return { chain: config.defaultChain, chainName: chainLabel(config.defaultChain), spot, aqua: config.aqua.address, router: config.aqua.router, tiers };
    }),
  );
}));

dashboardRouter.get("/dashboard/events", asyncHandler(async (req, res) => {
  const chains = chainsFor(req.query.chain);
  const stored = (await recentEvents(40, chains.length === 1 ? chains[0] : undefined)).filter((e) => chains.includes((e.chain ?? config.defaultChain) as CashChainKey));
  if (stored.length || !multibaasReady || !chains.some(viaMb)) {
    res.json({ source: "event-log", events: stored });
    return;
  }
  // Nothing streamed in yet (no webhook): read MultiBaas's index directly.
  const events = await cached("events", () => mbEvents({ limit: 40 })).catch(() => []);
  res.json({ source: "multibaas", events: events.map((e) => ({ ...e, chain: config.defaultChain })) });
}));

/// Where the event log stands on each chain it reads itself (blocks behind the head).
dashboardRouter.get("/dashboard/indexers", asyncHandler(async (_req, res) => {
  res.json({ indexers: await indexerStatus() });
}));
