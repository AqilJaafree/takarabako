"use client";

import { Fragment, useState } from "react";
import { createPublicClient, http, keccak256, slice, toBytes, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { AgentReportSummary, AgentRun, IntegrityReport, MandateStatus } from "@/lib/opsTypes";
import { shortHex, SEPOLIA_TX, timeAgo, usd } from "@/lib/format";

/// The AI treasury agent at a glance: it checks the cash (three independent
/// records per kiosk), acts within a visible mandate, and publishes a daily
/// report whose hash is anchored on Sepolia — verifiable in this browser.

const ANCHOR_PREFIX = "TKB-REPORT";
const SEV_ICON = { critical: "⛔", warn: "!", info: "i" } as const;

async function operatorPost<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-ops-token": token }, body: "{}" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

export function AiTreasury({
  integrity,
  mandate,
  reports,
  token,
  onChanged,
}: {
  integrity: IntegrityReport[] | null;
  mandate: MandateStatus | null;
  reports: AgentReportSummary[] | null;
  token: string;
  onChanged: () => void;
}) {
  return (
    <section className="ai-band" aria-labelledby="ai-band-title">
      <div className="ai-band-head">
        <span className="ai-orb" aria-hidden="true" />
        <div>
          <h2 id="ai-band-title">AI treasury agent</h2>
          <p className="muted small">
            Watches the cash, acts only within its mandate, and signs a daily report on-chain. Every action is logged below.
          </p>
        </div>
      </div>
      <div className="ai-grid">
        <IntegrityCard kiosks={integrity} token={token} onChanged={onChanged} />
        <MandateCard mandate={mandate} />
        <ReportCard reports={reports} token={token} onChanged={onChanged} />
      </div>
    </section>
  );
}

// ---- 1. cash integrity -------------------------------------------------

function IntegrityCard({ kiosks, token, onChanged }: { kiosks: IntegrityReport[] | null; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ kioskId: string; run: AgentRun } | null>(null);
  const [error, setError] = useState("");

  async function investigate(kioskId: string) {
    if (!token) {
      setError("Enter the operator token in the agent panel below first.");
      return;
    }
    setBusy(kioskId);
    setError("");
    try {
      const r = await operatorPost<{ run: AgentRun }>(`/api/ops/integrity/${encodeURIComponent(kioskId)}/investigate`, token);
      setVerdict({ kioskId, run: r.run });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "investigation failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card ai-card">
      <h3>Cash integrity</h3>
      <p className="muted small">Three independent records per kiosk must agree: notes signed by the kiosk&apos;s device key, tkCASH minted on-chain, and physical counts.</p>
      {!kiosks ? (
        <p className="ops-empty">Integrity check unavailable.</p>
      ) : (
        kiosks.map((k) => (
          <div key={k.kioskId} className={`integrity-kiosk st-${k.status}`}>
            <div className="spread">
              <span className="mono">{k.kioskId}</span>
              <span className={`pill ${k.status === "clear" ? "ok" : k.status === "warn" ? "warn" : "bad"}`}>
                {k.status === "clear" ? "All three agree" : k.status === "warn" ? "Check" : "Mismatch"}
              </span>
            </div>
            <div className="integrity-trio">
              <div>
                <span className="label">Signed notes</span>
                <b className="amount">{usd(k.machine.usd)}</b>
                <span className="muted small">{k.machine.notes} notes · {k.windowDays}d</span>
              </div>
              <div>
                <span className="label">Minted</span>
                <b className="amount">{usd(k.chain.usd)}</b>
                <span className="muted small">{k.chain.mints} mints · reserve {k.chain.reserve === null ? "—" : usd(k.chain.reserve)}</span>
              </div>
              <div>
                <span className="label">Last count</span>
                <b className="amount">{k.lastCount ? usd(k.lastCount.counted) : "—"}</b>
                <span className={`small ${k.lastCount && k.lastCount.delta !== 0 ? "tone-bad" : "muted"}`}>
                  {k.lastCount ? (k.lastCount.delta === 0 ? "matches" : `${k.lastCount.delta < 0 ? "−" : "+"}${usd(Math.abs(k.lastCount.delta))} vs chain`) : "never counted"}
                </span>
              </div>
            </div>
            {k.findings.length > 0 && (
              <ul className="integrity-findings">
                {k.findings.map((f) => (
                  <li key={f.code} className={`sev-${f.severity}`}>
                    <span className="sev-badge" aria-hidden="true">{SEV_ICON[f.severity]}</span>
                    <div>
                      <b>{f.title}</b>
                      <p className="muted small">{f.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {k.status !== "clear" && (
              <button className="btn btn-gold small" onClick={() => investigate(k.kioskId)} disabled={busy !== null}>
                {busy === k.kioskId ? "The agent is investigating…" : "Ask the agent to investigate"}
              </button>
            )}
          </div>
        ))
      )}
      {error && <div className="notice error">{error}</div>}
      {verdict && <AgentVerdict title={`Agent on ${verdict.kioskId}`} run={verdict.run} />}
    </article>
  );
}

function AgentVerdict({ title, run }: { title: string; run: AgentRun }) {
  const acted = run.trace.filter((t) => t.tool.startsWith("propose_"));
  return (
    <div className="agent-verdict">
      <p className="label" style={{ margin: 0 }}>{title}</p>
      <Markdown text={run.answer} />
      {acted.map((t, i) => {
        const out = t.output as { executed?: boolean; proposed?: boolean; txHash?: string; rejected?: boolean; reason?: string };
        return (
          <p key={i} className="small" style={{ margin: "6px 0 0" }}>
            {out.executed ? (
              <span className="pill ok">Done on its own</span>
            ) : out.proposed ? (
              <span className="pill warn">Needs your approval</span>
            ) : (
              <span className="pill bad">Rejected by policy</span>
            )}{" "}
            <span className="mono">{t.tool.replace("propose_", "")}</span>
            {out.txHash && (
              <> · <a href={SEPOLIA_TX(out.txHash)} target="_blank" rel="noreferrer" className="mono">{shortHex(out.txHash)}</a></>
            )}
            {out.reason && <span className="muted"> — {out.reason}</span>}
          </p>
        );
      })}
      <p className="muted small" style={{ margin: "6px 0 0" }}>{run.trace.length} tool calls · {run.model}</p>
    </div>
  );
}

// ---- 2. mandate ----------------------------------------------------------

function MandateCard({ mandate }: { mandate: MandateStatus | null }) {
  return (
    <article className="card ai-card">
      <div className="spread">
        <h3>Mandate</h3>
        {mandate && <span className={`pill ${mandate.enabled ? "ok" : "warn"}`}>{mandate.enabled ? "Autonomy on" : "Autonomy off"}</span>}
      </div>
      <p className="muted small">What the agent may do by itself. Anything else, or anything past a limit, waits for an operator. Hard policy limits apply on top.</p>
      {!mandate ? (
        <p className="ops-empty">Mandate unavailable.</p>
      ) : (
        <ul className="mandate-list">
          {mandate.rules.map((r) => {
            const frac = r.dailyLimit ? Math.min(1, r.usedToday / r.dailyLimit) : 0;
            return (
              <li key={r.action}>
                <div className="spread">
                  <b>{r.label}</b>
                  <span className={`mandate-tag ${r.autonomous && mandate.enabled ? "own" : "human"}`}>
                    {r.autonomous && mandate.enabled ? "On its own" : "Needs you"}
                  </span>
                </div>
                {r.dailyLimit !== null && r.autonomous ? (
                  <>
                    <div className="mandate-bar" role="img" aria-label={`${r.usedToday} of ${r.dailyLimit} USDC used today`}>
                      <span style={{ width: `${frac * 100}%` }} />
                    </div>
                    <span className="muted small">{usd(r.usedToday, 0)} of {usd(r.dailyLimit, 0)} today</span>
                  </>
                ) : (
                  <span className="muted small">{r.action === "pause_kiosk" && r.usedToday ? `${r.usedToday} today · ` : ""}{r.why}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

// ---- 3. daily report -----------------------------------------------------

type Verification = { state: "idle" | "checking" } | { state: "ok"; tx: string } | { state: "fail"; reason: string };

function ReportCard({ reports, token, onChanged }: { reports: AgentReportSummary[] | null; token: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verify, setVerify] = useState<Verification>({ state: "idle" });
  const latest = reports?.[0] ?? null;

  async function writeNow() {
    if (!token) {
      setError("Enter the operator token in the agent panel below first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await operatorPost("/api/ops/reports", token);
      setVerify({ state: "idle" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't write the report");
    } finally {
      setBusy(false);
    }
  }

  /// Re-hashes the published canonical JSON here, reads the anchor
  /// transaction from Sepolia, and checks it carries the same hash.
  async function verifyLatest() {
    if (!latest) return;
    setVerify({ state: "checking" });
    try {
      const res = await fetch(`/api/ops/reports/${latest.id}`);
      const { report } = (await res.json()) as { report: { canonical: string; hash: string; anchorTx: string | null } };
      const hash = keccak256(toBytes(report.canonical));
      if (hash !== report.hash) return setVerify({ state: "fail", reason: "the report text doesn't match its published hash" });
      if (!report.anchorTx) return setVerify({ state: "fail", reason: "this report wasn't anchored on-chain" });
      const client = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
      const tx = await client.getTransaction({ hash: report.anchorTx as Hex });
      const onChain = slice(tx.input, ANCHOR_PREFIX.length);
      if (onChain.toLowerCase() !== hash.toLowerCase()) return setVerify({ state: "fail", reason: "the on-chain anchor holds a different hash" });
      setVerify({ state: "ok", tx: report.anchorTx });
    } catch (e) {
      setVerify({ state: "fail", reason: e instanceof Error ? e.message : "verification failed" });
    }
  }

  return (
    <article className="card ai-card ai-report">
      <div className="spread">
        <h3>Daily report</h3>
        {latest && <span className="muted small">{timeAgo(latest.createdAt)}</span>}
      </div>
      {!reports ? (
        <p className="ops-empty">Reports unavailable.</p>
      ) : !latest ? (
        <p className="ops-empty">No report yet. The agent writes one a day.</p>
      ) : (
        <>
          <div className="report-body"><Markdown text={latest.body} /></div>
          <div className="report-proof">
            <span className="label">keccak256</span>
            <code className="mono small" title={latest.hash}>{shortHex(latest.hash, 10, 8)}</code>
            {latest.anchorTx ? (
              <a href={SEPOLIA_TX(latest.anchorTx)} target="_blank" rel="noreferrer" className="small">Anchored on Sepolia ↗</a>
            ) : (
              <span className="muted small">not anchored</span>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={verifyLatest} disabled={verify.state === "checking"}>
              {verify.state === "checking" ? "Checking Sepolia…" : "Verify in my browser"}
            </button>
            {verify.state === "ok" && <span className="pill ok">✓ Hash matches the on-chain anchor</span>}
            {verify.state === "fail" && <span className="pill bad">✗ {verify.reason}</span>}
          </div>
        </>
      )}
      {error && <div className="notice error">{error}</div>}
      <button className="btn btn-ghost small" style={{ marginTop: 10 }} onClick={writeNow} disabled={busy}>
        {busy ? "Writing and anchoring…" : "Write report now"}
      </button>
    </article>
  );
}

// ---- a tiny Markdown renderer (headings, bold, lists) -------------------

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>,
  );
}

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    out.push(h ? <h4 key={out.length}>{inline(h[1])}</h4> : <p key={out.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="md">{out}</div>;
}
