"use client";

import { useState } from "react";
import type { AgentRun, Alert, Proposal } from "@/lib/opsTypes";
import { shortHex, SEPOLIA_TX, timeAgo } from "@/lib/format";

const EXAMPLES = [
  "Is the yield reserve enough for the next 30 days?",
  "Which kiosk holds the most cash, and is it fully backed?",
  "Raise the vault APY to 50%.",
  "Top up the yield reserve with 100 USDC.",
];

const ACTION_LABEL: Record<Proposal["action"], string> = {
  fund_yield_reserve: "Fund yield reserve",
  set_apy: "Set vault APY",
  pause_kiosk: "Pause kiosk",
  mint_usdc_float: "Mint mUSDC float",
};

function describeArgs(p: Proposal) {
  const a = p.args;
  switch (p.action) {
    case "fund_yield_reserve":
    case "mint_usdc_float":
      return `${a.amount} USDC`;
    case "set_apy":
      return `${Number(a.bps) / 100}% (${a.bps} bps)`;
    case "pause_kiosk":
      return `${a.kioskId}: ${a.reason}`;
  }
}

/// Ask the treasury agent, and approve or reject what it proposes.
export function AgentPanel({
  proposals,
  alerts,
  onChanged,
  token,
  setToken,
}: {
  proposals: Proposal[];
  alerts: Alert[];
  onChanged: () => void;
  token: string;
  setToken: (v: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setError("");
    setRun(null);
    try {
      const res = await fetch("/api/ops/ask", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": token },
        body: JSON.stringify({ question }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the agent couldn't answer");
      setRun(body);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "the agent couldn't answer");
    } finally {
      setAsking(false);
    }
  }

  async function decide(id: string, decision: "approve" | "reject") {
    setDeciding(id);
    setError("");
    try {
      const res = await fetch(`/api/ops/proposals/${id}/${decision}`, { method: "POST", headers: { "x-ops-token": token } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `couldn't ${decision}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `couldn't ${decision}`);
    } finally {
      setDeciding(null);
    }
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending").slice(0, 8);

  return (
    <div className="ops-grid ops-agent">
      <section className="card">
        <h2>Ask the treasury agent</h2>
        <p className="muted small">
          Claude reads live data through MultiBaas and can only <b>propose</b> actions. Limits are enforced in code, and nothing moves until an operator approves.
        </p>
        <label className="label" htmlFor="ops-token">Operator token</label>
        <input
          id="ops-token"
          className="input"
          type="password"
          autoComplete="off"
          placeholder="OPS_ADMIN_TOKEN"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ margin: "6px 0 12px" }}
        />
        <form onSubmit={ask}>
          <textarea
            className="input ops-question"
            rows={3}
            placeholder="Ask about reserves, yield, kiosks…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <div className="row" style={{ margin: "8px 0 12px" }}>
            {EXAMPLES.map((q) => (
              <button key={q} type="button" className="btn btn-ghost small ops-chip" onClick={() => setQuestion(q)}>
                {q}
              </button>
            ))}
          </div>
          <button className="btn btn-gold btn-block" disabled={asking || !question.trim() || !token}>
            {asking ? "Thinking… (reading on-chain data)" : "Ask"}
          </button>
        </form>
        {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}
        {run && (
          <div className="ops-answer">
            <p className="label">Answer <span className="muted">· {run.model}</span></p>
            <div className="ops-answer-text">{run.answer}</div>
            {run.trace.length > 0 && (
              <details>
                <summary>{run.trace.length} tool call{run.trace.length === 1 ? "" : "s"}</summary>
                <ol className="ops-trace">
                  {run.trace.map((t, i) => (
                    <li key={i} className={t.error ? "tone-bad" : undefined}>
                      <code>{t.tool}({JSON.stringify(t.input)})</code>
                      <pre>{JSON.stringify(t.output, null, 2).slice(0, 1200)}</pre>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Proposals</h2>
        {pending.length === 0 ? (
          <p className="ops-empty">No proposals waiting.</p>
        ) : (
          <ul className="ops-proposals">
            {pending.map((p) => (
              <li key={p.id}>
                <div className="spread">
                  <b>{ACTION_LABEL[p.action]}</b>
                  <span className="pill warn">Awaiting approval</span>
                </div>
                <p className="ops-prop-args">{describeArgs(p)}</p>
                <p className="muted small">{p.rationale}</p>
                <p className="muted small">{p.source === "monitor" ? "Raised by the monitor" : "From a question"} · {timeAgo(p.createdAt)}</p>
                <div className="row">
                  <button className="btn btn-gold small" disabled={!token || deciding === p.id} onClick={() => decide(p.id, "approve")}>
                    {deciding === p.id ? "Working…" : "Approve & execute"}
                  </button>
                  <button className="btn btn-ghost small" disabled={!token || deciding === p.id} onClick={() => decide(p.id, "reject")}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <>
            <p className="label" style={{ marginTop: 16 }}>Decided</p>
            <ul className="ops-feed">
              {decided.map((p) => (
                <li key={p.id}>
                  <span className="ops-feed-what">
                    {ACTION_LABEL[p.action]} · {describeArgs(p)}{" "}
                    <span className={`pill ${p.status === "executed" ? "ok" : p.status === "rejected" ? "" : "bad"}`}>{p.status}</span>
                    {p.autonomous && <span className="pill ok" title="Executed by the agent within its mandate">agent · on its own</span>}
                  </span>
                  <span className="muted small">
                    {p.txHash ? <a href={SEPOLIA_TX(p.txHash)} target="_blank" rel="noreferrer">{shortHex(p.txHash)}</a> : p.error ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="label" style={{ marginTop: 16 }}>Monitor alerts</p>
        {alerts.length === 0 ? (
          <p className="ops-empty">No alerts.</p>
        ) : (
          <ul className="ops-feed">
            {alerts.map((a) => (
              <li key={a.id}>
                <span className={`ops-feed-what ${a.severity === "critical" ? "tone-bad" : a.severity === "warn" ? "tone-warn" : ""}`}>
                  {a.severity === "critical" ? "⛔ " : a.severity === "warn" ? "! " : "i "}
                  {a.message}
                </span>
                <span className="muted small">{a.rule} · {timeAgo(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
