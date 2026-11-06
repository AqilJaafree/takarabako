"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionItem, ChainEvent, ChainFilter, ChainKey, ChainSummary, KioskState, OpsData, Severity, Summary, Holders, Flows, Positions } from "@/lib/opsTypes";
import { addressUrl, apy, chainName, shortHex, timeAgo, txUrl, usd } from "@/lib/format";
import { FlowsChart, HBars } from "./charts";
import { AgentPanel } from "./AgentPanel";
import { AiTreasury } from "./AiTreasury";
import { ChainsPanel } from "./ChainsPanel";
import { BridgePanel } from "./BridgePanel";
import { BRAND_MARK } from "@/lib/theme";

const REFRESH_MS = 20_000; // matches the backend's panel cache

const ok = <T,>(v: T | { error: string }): v is T => !(v && typeof v === "object" && "error" in v && Object.keys(v).length === 1);

const SEVERITY: Record<Severity, { icon: string; label: string }> = {
  critical: { icon: "⛔", label: "Critical" },
  serious: { icon: "▲", label: "Serious" },
  warning: { icon: "!", label: "Warning" },
  info: { icon: "i", label: "Info" },
};

const TOKEN_KEY = "tb_ops_token";

/// The operator token, kept in this tab only (sessionStorage).
function useOpsToken(): [string, (v: string) => void] {
  const [token, setTokenState] = useState("");
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTokenState(sessionStorage.getItem(TOKEN_KEY) ?? "");
    } catch {}
  }, []);
  const setToken = useCallback((v: string) => {
    setTokenState(v);
    try {
      sessionStorage.setItem(TOKEN_KEY, v);
    } catch {}
  }, []);
  return [token, setToken];
}

/// POST to an operator endpoint with the token; throws the backend's error.
async function operatorPost(path: string, token: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-token": token },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as { txHash?: string };
}

export function OpsDashboard({ initial }: { initial: OpsData }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ChainFilter>(initial.chain ?? "all");
  const [token, setToken] = useOpsToken();

  const load = useCallback(async (chain: ChainFilter) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/ops/data?chain=${chain}`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setRefreshing(false);
    }
  }, []);
  const refresh = useCallback(() => load(filter), [load, filter]);

  useEffect(() => {
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const pick = (next: ChainFilter) => {
    setFilter(next);
    void load(next);
  };

  const summary = ok(data.summary) ? data.summary : null;

  return (
    <main className="ops">
      <header className="ops-head">
        <div>
          <div className="brand"><span className="kanji">{BRAND_MARK}</span> Treasury ops</div>
          <p className="muted small">Proof of reserve, vault health, bridging and the treasury agent across Ethereum Sepolia, Arc Testnet and Hedera Testnet. Sepolia data via Curvegrid MultiBaas; Arc from the chain&apos;s own event log.</p>
        </div>
        <div className="row">
          <div className="ops-filter" role="group" aria-label="Chain">
            {(["all", "sepolia", "arc-testnet", "hedera-testnet"] as const).map((c) => (
              <button key={c} aria-pressed={filter === c} onClick={() => pick(c)}>{c === "all" ? "All chains" : chainName(c)}</button>
            ))}
          </div>
          {summary && (
            <>
              <span className={`pill ${summary.multibaas ? "ok" : "bad"}`}>{summary.multibaas ? "MultiBaas connected" : "MultiBaas not configured"}</span>
              <span className={`pill ${summary.cashReceipt ? "ok" : "warn"}`}>{summary.cashReceipt ? "tkCASH live" : "tkCASH not deployed"}</span>
            </>
          )}
          <button className="btn btn-ghost small" onClick={refresh} disabled={refreshing} suppressHydrationWarning>
            {refreshing ? "Refreshing…" : `Updated ${new Date(data.loadedAt).toLocaleTimeString()}`}
          </button>
        </div>
      </header>

      {!summary && <div className="notice error">Couldn&apos;t load the dashboard: {"error" in data.summary ? data.summary.error : ""}</div>}
      {summary && !summary.multibaas && <SetupNotice />}

      <AiTreasury
        integrity={ok(data.integrity) ? data.integrity.kiosks : null}
        mandate={ok(data.mandate) ? data.mandate : null}
        reports={ok(data.reports) ? data.reports.reports : null}
        token={token}
        onChanged={refresh}
      />

      {summary && <ActionItems items={summary.actionItems} />}
      {summary && <StatTiles summary={summary} flows={ok(data.flows) ? data.flows : null} filter={filter} />}
      {summary && <ChainsPanel chains={summary.chains} indexers={summary.indexers} />}
      <BridgePanel bridge={ok(data.bridge) ? data.bridge : null} token={token} onChanged={refresh} />

      <div className="ops-grid">
        {summary && <ReservePanel summary={summary} token={token} onChanged={refresh} />}
        <section className="card">
          <h2>Banknote mix</h2>
          <p className="muted small">USD minted as tkCASH per note face value, from the CashIn events of the chains selected.</p>
          {ok(data.flows) && data.flows.denominations.data ? (
            <HBars
              rows={data.flows.denominations.data.map((d) => ({ key: String(d.denomination), label: `${d.denomination} note`, value: d.total }))}
              emptyText="No notes recorded yet."
              valueLabel="Minted"
            />
          ) : (
            <PanelError error={ok(data.flows) ? data.flows.denominations.error : data.flows.error} />
          )}
        </section>
      </div>

      <section className="card">
        <div className="spread">
          <h2>Liquidity flows</h2>
          {ok(data.flows) && (
            <span className="muted small">
              Withdrawals ({data.flows.days} days): {data.flows.withdrawals.count} · {usd(data.flows.withdrawals.gross)} gross · {usd(data.flows.withdrawals.fees)} in fees
            </span>
          )}
        </div>
        <p className="muted small">Cash in and out of the kiosks per day, from tkCASH CashIn/CashOut events. Totals cover the chains selected.</p>
        {ok(data.flows) ? <FlowsChart daily={data.flows.daily} /> : <PanelError error={data.flows.error} />}
      </section>

      <div className="ops-grid">
        <HoldersPanel holders={ok(data.holders) ? data.holders : null} error={ok(data.holders) ? null : data.holders.error} />
        <DepositorsPanel holders={ok(data.holders) ? data.holders : null} />
      </div>

      <div className="ops-grid">
        <PositionsPanel positions={ok(data.positions) ? data.positions : null} error={ok(data.positions) ? null : data.positions.error} />
        <EventsPanel events={ok(data.events) ? data.events.events : null} source={ok(data.events) ? data.events.source : null} />
      </div>

      <AgentPanel proposals={summary?.proposals ?? []} alerts={summary?.alerts ?? []} onChanged={refresh} token={token} setToken={setToken} />
    </main>
  );
}

function PanelError({ error }: { error: string | null | undefined }) {
  return <p className="ops-empty">{error ?? "No data."}</p>;
}

function SetupNotice() {
  return (
    <div className="notice pending">
      <b>MultiBaas isn&apos;t connected.</b> The dashboard falls back to each chain&apos;s own event log, which only fills from the moment the backend starts. For Sepolia&apos;s full history, set <code>MULTIBAAS_URL</code> and{" "}
      <code>MULTIBAAS_API_KEY</code> in <code>backend/.env</code> and run <code>npm run mb:setup</code> in <code>backend/</code>.
    </div>
  );
}

function ActionItems({ items }: { items: ActionItem[] }) {
  return (
    <section className="card">
      <h2>Action items</h2>
      {items.length === 0 ? (
        <p className="ops-allclear"><span aria-hidden="true">✓</span> Nothing needs attention.</p>
      ) : (
        <ul className="ops-actions">
          {items.map((it, i) => (
            <li key={i} className={`sev-${it.severity}`}>
              <span className="sev-badge" aria-hidden="true">{SEVERITY[it.severity].icon}</span>
              <div>
                <b>{it.title}</b> <span className="sev-label">{SEVERITY[it.severity].label}</span>
                <p className="muted small">{it.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="ops-tile">
      <span className="label">{label}</span>
      <span className="ops-tile-value">{value}</span>
      {sub && <span className={`small ${tone ? `tone-${tone}` : "muted"}`}>{sub}</span>}
    </div>
  );
}

function StatTiles({ summary, flows, filter }: { summary: Summary; flows: Flows | null; filter: ChainFilter }) {
  const t = summary.totals;
  const anyTk = summary.chains.some((c) => c.reserve.data?.configured);
  const backed = summary.chains.every((c) => !c.reserve.data?.configured || c.reserve.data.backed);
  const covs = summary.chains.map((c) => c.vault.data?.reserveCoverage).filter((v): v is number => v != null);
  const worst = covs.length ? Math.min(...covs) : null;
  const lowGas = summary.chains.filter((c) => {
    const tr = c.treasury.data;
    return c.ready && tr && (tr.gasIsUsdc ? (tr.native ?? 0) < 1 : (tr.native ?? tr.eth) < 0.05);
  });
  const scope = filter === "all" ? "both chains" : chainName(filter);
  return (
    <section className="ops-tiles">
      <Tile
        label="tkCASH supply"
        value={anyTk ? usd(t.tkcashSupply) : "—"}
        sub={anyTk ? (backed ? `✓ Fully backed · ${scope}` : "✗ Supply ≠ reserve on a chain") : "not deployed"}
        tone={anyTk ? (backed ? "ok" : "bad") : undefined}
      />
      <Tile label="Cash in kiosks" value={anyTk ? usd(t.tkcashReserve) : "—"} sub={anyTk ? `across ${scope}` : undefined} />
      <Tile label="Vaults owe" value={usd(t.liabilityUsd)} sub={`${usd(t.vaultUsdcBalance)} USDC held · ${scope}`} />
      <Tile
        label="Weakest coverage"
        value={worst == null ? "—" : `${worst.toFixed(2)}×`}
        sub={worst == null ? undefined : "lowest vault balance ÷ liability"}
        tone={worst == null ? undefined : worst < 1 ? "bad" : worst < 1.2 ? "warn" : "ok"}
      />
      <Tile
        label="Treasury USDC"
        value={usd(t.treasuryUsdc)}
        sub={lowGas.length ? `✗ Top up gas on ${lowGas.map((c) => c.name).join(", ")}` : "✓ Enough gas for deposits"}
        tone={lowGas.length ? "bad" : "ok"}
      />
      <Tile label="In flight" value={String(summary.bridge.inFlight)} sub="bridge transfers between chains" tone={summary.bridge.inFlight ? "warn" : undefined} />
      <Tile label="Fee revenue" value={flows ? usd(flows.withdrawals.fees) : "—"} sub={`${summary.feeBps / 100}% on cash withdrawals · ${flows?.days ?? 14}d`} />
    </section>
  );
}

function ReservePanel({ summary, token, onChanged }: { summary: Summary; token: string; onChanged: () => void }) {
  return (
    <section className="card">
      <h2>Proof of reserve</h2>
      <p className="muted small">Each tkCASH is a claim on one dollar of banknotes in a kiosk. Operators count the box; a mismatch freezes that kiosk.</p>
      {summary.chains.map((c) => (
        <ChainReserve key={c.chain} c={c} retired={summary.retiredKiosks} token={token} onChanged={onChanged} />
      ))}
    </section>
  );
}

function ChainReserve({ c, retired, token, onChanged }: { c: ChainSummary; retired?: string[]; token: string; onChanged: () => void }) {
  const r = c.reserve.data;
  return (
    <div style={{ marginTop: 14 }}>
      <p className="label">{c.name}</p>
      {!r?.configured ? (
        <PanelError error={c.reserve.error ?? "Deploy tkCASH on this chain and set its CASH_RECEIPT_ADDRESS to see reserves."} />
      ) : (
        <>
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead><tr><th>Kiosk</th><th>On-chain reserve</th><th>Status</th><th>Last count</th></tr></thead>
              <tbody>
                {r.kiosks.map((k) => (
                  <tr key={k.kioskId}>
                    <td className="mono">{k.kioskId}</td>
                    <td>{usd(k.reserve)}</td>
                    <td>
                      <span className={`pill ${k.frozen ? "bad" : k.active ? "ok" : retired?.includes(k.kioskId) ? "" : "warn"}`}>
                        {k.frozen ? "Frozen" : k.active ? "In service" : retired?.includes(k.kioskId) ? "Retired" : "Out of service"}
                      </span>
                    </td>
                    <td>{k.lastAuditAt ? timeAgo(new Date(k.lastAuditAt * 1000).toISOString()) : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.kiosks.filter((k) => !retired?.includes(k.kioskId) && (k.active || k.reserve > 0 || k.frozen)).map((k) => (
            <CountForm key={k.kioskId} kiosk={k} chain={c.chain} token={token} onChanged={onChanged} />
          ))}
          {r.attestations.length > 0 && (
            <div className="ops-table-wrap" style={{ marginTop: 10 }}>
              <table className="ops-table">
                <thead><tr><th>Recent counts</th><th>Counted</th><th>Chain</th><th>Difference</th></tr></thead>
                <tbody>
                  {r.attestations.map((a, i) => (
                    <tr key={i}>
                      <td className="mono">{a.kioskId}</td>
                      <td>{usd(a.counted)}</td>
                      <td>{usd(a.onChain)}</td>
                      <td className={a.delta === 0 ? "tone-ok" : "tone-bad"}>{a.delta === 0 ? "✓ matches" : `✗ ${usd(a.delta)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const who = (name: string | null, address: string) => name ?? shortHex(address);
const chainSplit = (chains?: Record<string, number>) =>
  chains && Object.keys(chains).length > 1 ? ` · ${Object.entries(chains).map(([k, v]) => `${chainName(k)} ${usd(v)}`).join(", ")}` : "";

function HoldersPanel({ holders, error }: { holders: Holders | null; error: string | null }) {
  const tk = holders?.tkcash.data;
  return (
    <section className="card">
      <h2>tkCASH holders</h2>
      <p className="muted small">Balances rebuilt from Transfer events, summed across the chains selected.</p>
      {!tk ? (
        <PanelError error={holders?.tkcash.error ?? error} />
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="pill">{tk.count} holders</span>
            <span className="pill">Top holder {(tk.top1Share * 100).toFixed(0)}%</span>
            <span className="pill">Top 3 {(tk.top3Share * 100).toFixed(0)}%</span>
          </div>
          <HBars
            rows={tk.holders.map((h) => ({ key: h.address, label: who(h.name, h.address), value: h.balance, hint: `${h.name ? `${h.name} (${h.address})` : h.address}${chainSplit(h.chains)}` }))}
            emptyText="No tkCASH minted yet."
            valueLabel="Balance"
          />
        </>
      )}
    </section>
  );
}

function DepositorsPanel({ holders }: { holders: Holders | null }) {
  const v = holders?.vault.data;
  return (
    <section className="card">
      <h2>Vault depositors</h2>
      <p className="muted small">Principal deposited per customer, summed across the chains selected.</p>
      {!v ? (
        <PanelError error={holders?.vault.error} />
      ) : (
        <HBars
          rows={v.depositors.map((d) => ({ key: d.address, label: who(d.name, d.address), value: d.deposited, hint: `${d.name ? `${d.name} (${d.address})` : d.address}${chainSplit(d.chains)}` }))}
          emptyText="No vault deposits indexed yet."
          valueLabel="Deposited"
        />
      )}
    </section>
  );
}

function PositionsPanel({ positions, error }: { positions: Positions | null; error: string | null }) {
  return (
    <section className="card">
      <h2>1inch Aqua strategies{positions?.chainName ? ` · ${positions.chainName}` : ""}</h2>
      <p className="muted small">
        ETH/USDC SwapVM strategies the treasury has shipped through{" "}
        {positions ? <a href={addressUrl(positions.aqua)} target="_blank" rel="noreferrer">Aqua</a> : "Aqua"}, valued live
        {positions?.spot ? ` at ETH ${usd(positions.spot, 0)}` : ""}.
      </p>
      {!positions ? (
        <PanelError error={error} />
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead><tr><th>Tier</th><th>Range</th><th>Est. APY</th><th>Open</th><th>Strategies</th><th>In</th><th>Value</th><th>In range</th></tr></thead>
            <tbody>
              {positions.tiers.map((t) => (
                <tr key={t.mode}>
                  <td>{t.label}</td>
                  <td>{t.range}</td>
                  <td>{apy(t.apyBps)}</td>
                  <td>{t.open}</td>
                  <td>{t.strategies}</td>
                  <td>{usd(t.amountUsd)}</td>
                  <td>{usd(t.valueUsd)}</td>
                  <td>{t.open === 0 ? "—" : t.inRange === t.open ? <span className="tone-ok">✓ all</span> : <span className="tone-warn">{t.inRange}/{t.open}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function describe(e: ChainEvent): string {
  const usd6 = (v?: string) => (v ? usd(Number(v) / 1e6) : "");
  switch (e.name) {
    case "CashIn": return `Cash in ${usd6(e.inputs.amount)} (${e.inputs.denomination} note)`;
    case "CashOut": return `Cash out ${usd6(e.inputs.amount)}`;
    case "Deposited": return `Vault deposit ${usd6(e.inputs.usdcAmount)}`;
    case "Withdrawn": return `Vault withdrawal ${usd6(e.inputs.usdcAmount)}`;
    case "ReserveAttested": return `Count: ${usd6(e.inputs.counted)} vs chain ${usd6(e.inputs.onChain)}`;
    case "Shipped": return "Aqua strategy shipped";
    case "Docked": return "Aqua strategy docked";
    case "Pulled": return `Aqua swap: out ${e.inputs.token?.toLowerCase().startsWith("0x6cc5") ? usd6(e.inputs.amount) + " USDC" : "mETH"}`;
    case "Pushed": return `Aqua swap: in ${e.inputs.token?.toLowerCase().startsWith("0x6cc5") ? usd6(e.inputs.amount) + " USDC" : "mETH"}`;
    default: return e.name;
  }
}

function EventsPanel({ events, source }: { events: ChainEvent[] | null; source: string | null }) {
  return (
    <section className="card">
      <div className="spread">
        <h2>Live events</h2>
        {source && <span className="muted small">{source === "multibaas" ? "via MultiBaas index" : "from the event log"}</span>}
      </div>
      {!events || events.length === 0 ? (
        <p className="ops-empty">No events yet. They appear here as each chain&apos;s contracts emit them.</p>
      ) : (
        <ul className="ops-feed">
          {events.slice(0, 15).map((e, i) => (
            <li key={e.id ?? `${e.txHash}-${i}`}>
              <span className="ops-feed-what">{describe(e)}</span>
              <span className="muted small">
                {e.contractLabel} · {timeAgo(e.triggeredAt)}{e.chain && <span className="chain-chip">{chainName(e.chain)}</span>}
                {e.txHash && (
                  <> · <a href={txUrl(e.txHash, e.chain)} target="_blank" rel="noreferrer">{shortHex(e.txHash)}</a></>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


/// An operator's physical cash count, recorded on-chain. A count that differs
/// from the chain freezes the kiosk; a human unfreezes it after resolving.
function CountForm({ kiosk, chain, token, onChanged }: { kiosk: KioskState; chain: ChainKey; token: string; onChanged: () => void }) {
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tx?: string } | null>(null);

  async function run(label: string, send: () => Promise<{ txHash?: string }>) {
    setBusy(true);
    setMsg(null);
    try {
      const { txHash } = await send();
      setMsg({ ok: true, text: label, tx: txHash });
      setCounted("");
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "failed" });
    } finally {
      setBusy(false);
    }
  }

  const value = Number(counted);
  return (
    <div className="ops-count">
      <p className="label">Record a count · {kiosk.kioskId} · {chainName(chain)}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(value === kiosk.reserve ? "Count recorded — matches the chain." : "Count recorded — it differs, so the kiosk is now frozen.", () =>
            operatorPost("/api/ops/attest", token, { kioskId: kiosk.kioskId, counted: value, chain }),
          );
        }}
      >
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          placeholder={`USD counted (chain says ${usd(kiosk.reserve)})`}
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          aria-label="USD counted in the box"
        />
        <button className="btn btn-gold small" disabled={busy || !token || counted === "" || !(value >= 0)}>
          {busy ? "Recording…" : "Record count"}
        </button>
        {kiosk.frozen && (
          <button
            type="button"
            className="btn btn-ghost small"
            disabled={busy || !token}
            onClick={() => void run("Kiosk unfrozen.", () => operatorPost(`/api/ops/kiosks/${encodeURIComponent(kiosk.kioskId)}/unfreeze`, token, { chain }))}
          >
            Unfreeze
          </button>
        )}
      </form>
      {!token && <p className="muted small">Enter the operator token in the agent panel below to record counts.</p>}
      {msg && (
        <p className={`small ${msg.ok ? "tone-ok" : "tone-bad"}`}>
          {msg.text}
          {msg.tx && (
            <> · <a href={txUrl(msg.tx, chain)} target="_blank" rel="noreferrer">{shortHex(msg.tx)}</a></>
          )}
        </p>
      )}
    </div>
  );
}
