"use client";

import { useState } from "react";
import type { BridgeOverview, BridgeRow, ChainKey } from "@/lib/opsTypes";
import { chainName, shortHex, timeAgo, txUrl, usd } from "@/lib/format";

const STATE_TEXT: Record<BridgeRow["state"], string> = {
  created: "Starting",
  withdrawn: "Left the box",
  burned: "Burned, waiting for Circle",
  attested: "Signed by Circle",
  minted: "Minted",
  credited: "Credited",
  failed: "Failed",
};

const CHAINS: ChainKey[] = ["sepolia", "arc-testnet"];

/// CCTP transfers between the chains, and a treasury rebalance form (operator token).
export function BridgePanel({ bridge, token, onChanged }: { bridge: BridgeOverview | null; token: string; onChanged: () => void }) {
  const [from, setFrom] = useState<ChainKey>("sepolia");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const to: ChainKey = from === "sepolia" ? "arc-testnet" : "sepolia";
  const value = Number(amount);

  async function rebalance() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/ops/bridge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": token },
        body: JSON.stringify({ from, to, amount: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
      setMsg({ ok: true, text: `Moving ${usd(value)} from ${chainName(from)} to ${chainName(to)}. It finishes once Circle signs the burn.` });
      setAmount("");
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="spread">
        <h2>Bridge</h2>
        {bridge && <span className={`pill ${bridge.inFlight ? "warn" : "ok"}`}>{bridge.inFlight ? `${bridge.inFlight} in flight · ${usd(bridge.inFlightUsd)}` : "Nothing in flight"}</span>}
      </div>
      <p className="muted small">USDC moves between Sepolia and Arc Testnet with Circle CCTP V2 (Hedera has no CCTP route: top it up from the treasury). Customers bridge from their box; the treasury can rebalance its own float below.</p>

      {bridge && bridge.volume.length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          {bridge.volume.map((v) => (
            <span key={`${v.from}-${v.to}`} className="pill">
              {chainName(v.from)} → {chainName(v.to)} · {v.count} · {usd(v.amountUsd)} (14d)
            </span>
          ))}
        </div>
      )}

      {!bridge || bridge.transfers.length === 0 ? (
        <p className="ops-empty">No transfers yet.</p>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead><tr><th>Route</th><th>Amount</th><th>Status</th><th>Transactions</th><th>When</th></tr></thead>
            <tbody>
              {bridge.transfers.slice(0, 8).map((t) => {
                const f = (t.from ?? t.fromChain) as ChainKey;
                const d = (t.to ?? t.toChain) as ChainKey;
                return (
                  <tr key={t.id}>
                    <td>{chainName(f)} → {chainName(d)}{t.kind === "treasury" && <span className="chain-chip">treasury</span>}</td>
                    <td>{usd(t.amountUsd)}</td>
                    <td className={t.state === "failed" ? "tone-bad" : t.state === "credited" || t.state === "minted" ? "tone-ok" : ""} title={t.error ?? undefined}>{STATE_TEXT[t.state]}</td>
                    <td className="small">
                      {t.burnTx && <a href={txUrl(t.burnTx, f)} target="_blank" rel="noreferrer">burn {shortHex(t.burnTx)}</a>}
                      {t.mintTx && <> · <a href={txUrl(t.mintTx, d)} target="_blank" rel="noreferrer">mint {shortHex(t.mintTx)}</a></>}
                    </td>
                    <td className="muted small">{timeAgo(t.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="label" style={{ marginTop: 16 }}>Rebalance treasury float</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void rebalance(); }}>
        <select className="input" value={from} onChange={(e) => setFrom(e.target.value as ChainKey)} aria-label="Move from">
          {CHAINS.map((c) => <option key={c} value={c}>{chainName(c)} →</option>)}
        </select>
        <input className="input" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder={`USDC to move to ${chainName(to)}`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="USDC to move" />
        <button className="btn btn-gold small" disabled={busy || !token || !(value > 0)}>{busy ? "Starting…" : "Move USDC"}</button>
      </form>
      {!token && <p className="muted small">Enter the operator token in the agent panel below to move funds.</p>}
      {msg && <p className={`small ${msg.ok ? "tone-ok" : "tone-bad"}`}>{msg.text}</p>}
    </section>
  );
}
