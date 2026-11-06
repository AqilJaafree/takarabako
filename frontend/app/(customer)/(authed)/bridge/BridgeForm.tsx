"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BridgeQuote, BridgeState, BridgeTransfer, ChainKey, Me } from "@/lib/types";
import { BRIDGE_CHAINS, chainName, shortHex, timeAgo, txUrl, usd } from "@/lib/format";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

const STEPS: Array<{ state: BridgeState; text: string }> = [
  { state: "withdrawn", text: "USDC leaves your box" },
  { state: "burned", text: "Burned on the source chain" },
  { state: "attested", text: "Signed by Circle" },
  { state: "minted", text: "Minted on the destination chain" },
  { state: "credited", text: "Added to your box" },
];
const ORDER: BridgeState[] = ["created", "withdrawn", "burned", "attested", "minted", "credited"];
const active = (t: BridgeTransfer) => t.state !== "credited" && t.state !== "failed";

export function BridgeForm({ me, initial }: { me: Me; initial: BridgeTransfer[] }) {
  const router = useRouter();
  const chains = me.balances.filter((b) => BRIDGE_CHAINS.includes(b.chain));
  const [from, setFrom] = useState<ChainKey>(chains[0]?.chain ?? "sepolia");
  const to: ChainKey = chains.find((c) => c.chain !== from)?.chain ?? (from === "sepolia" ? "arc-testnet" : "sepolia");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState(initial);
  const value = Number(amount);
  const here = chains.find((c) => c.chain === from)?.balance ?? 0;

  // A fresh quote as the amount settles.
  useEffect(() => {
    if (!(value > 0)) {
      const t = setTimeout(() => setQuote(null), 0);
      return () => clearTimeout(t);
    }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const q = await call<BridgeQuote>("/api/bridge/quote", { from, to, amount: value });
        if (live) {
          setQuote(q);
          setError("");
        }
      } catch (e) {
        if (live) {
          setQuote(null);
          setError(e instanceof Error ? e.message : "couldn't get a quote");
        }
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [from, to, value]);

  const reload = useCallback(async () => {
    const r = await call<{ transfers: BridgeTransfer[] }>("/api/bridge").catch(() => null);
    if (r) setTransfers(r.transfers);
  }, []);

  // While a transfer is running, check on it every few seconds.
  const running = transfers.some(active);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      await reload();
      router.refresh();
    }, 8000);
    return () => clearInterval(id);
  }, [running, reload, router]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      await call<BridgeTransfer>("/api/bridge", { from, to, amount: value });
      setAmount("");
      setQuote(null);
      await reload();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start the transfer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="chain-pick">
          <div>
            <label className="label" htmlFor="bridge-from">From</label>
            <select id="bridge-from" className="input" value={from} onChange={(e) => setFrom(e.target.value as ChainKey)}>
              {chains.map((c) => <option key={c.chain} value={c.chain}>{c.name} · {usd(c.balance)}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-ghost small" aria-label="Swap direction" onClick={() => setFrom(to)}>⇄</button>
          <div>
            <span className="label">To</span>
            <div className="input" aria-live="polite" style={{ display: "flex", alignItems: "center" }}>{chainName(to)}</div>
          </div>
        </div>

        <label className="label" htmlFor="bridge-amount" style={{ display: "block", marginTop: 14 }}>Amount (USDC)</label>
        <div className="row" style={{ flexWrap: "nowrap", marginTop: 6 }}>
          <input id="bridge-amount" className="input" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ margin: 0 }} />
          <button type="button" className="btn btn-ghost small chip" onClick={() => setAmount(String(Math.floor(here * 100) / 100))}>Max</button>
        </div>
        <p className="muted small" style={{ margin: "4px 0 0" }}>{usd(here)} in your {chainName(from)} box</p>

        {quote && (
          <p className="small" style={{ marginTop: 12 }}>
            You receive <b>{usd(quote.receiveUsd)}</b> in your {chainName(to)} box · fee {usd(quote.feeUsd)} · usually about {quote.estimatedMinutes} minutes.
            {!quote.enough && <span className="tone-bad"> Not enough on {chainName(from)}.</span>}
          </p>
        )}
        {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}

        <button className="btn btn-gold btn-block" style={{ marginTop: 14 }} disabled={busy || !quote || !quote.enough || chains.length < 2} onClick={start}>
          {busy ? "Starting…" : value > 0 ? `Move ${usd(value)} to ${chainName(to)}` : "Enter an amount"}
        </button>
        {chains.length < 2 && <p className="muted small">Bridging needs two of Sepolia and Arc Testnet to be set up (Hedera has no CCTP route).</p>}
      </section>

      <section className="card">
        <h2>Your transfers</h2>
        {transfers.length === 0 ? (
          <p className="muted" style={{ margin: "12px 0 0" }}>Nothing moved yet.</p>
        ) : (
          <ul className="list">
            {transfers.map((t) => (
              <li key={t.id} style={{ display: "block" }}>
                <div className="spread">
                  <span>
                    <b>{usd(t.amountUsd)}</b> · {chainName(t.fromChain)} → {chainName(t.toChain)}
                    <br />
                    <span className="muted small">{timeAgo(t.createdAt)}</span>
                  </span>
                  <span className={`pill ${t.state === "credited" ? "ok" : t.state === "failed" ? "bad" : "warn"}`}>
                    {t.state === "credited" ? "Done" : t.state === "failed" ? "Failed" : "In progress"}
                  </span>
                </div>
                {t.state === "failed" ? (
                  <p className="small tone-bad" style={{ margin: "8px 0 0" }}>{t.error ?? "The transfer didn't start, and nothing left your box."}</p>
                ) : (
                  <ol className="bridge-steps">
                    {STEPS.map((step) => {
                      const done = ORDER.indexOf(t.state) >= ORDER.indexOf(step.state);
                      const now = !done && ORDER.indexOf(t.state) === ORDER.indexOf(step.state) - 1;
                      const tx =
                        step.state === "withdrawn" ? t.withdrawTx : step.state === "burned" ? t.burnTx : step.state === "minted" ? t.mintTx : step.state === "credited" ? t.creditTx : null;
                      const onChain = step.state === "minted" || step.state === "credited" ? t.toChain : t.fromChain;
                      return (
                        <li key={step.state} className={done ? "is-done" : now ? "is-now" : undefined}>
                          <span aria-hidden="true">{done ? "✓" : now ? "…" : "○"}</span> {step.text}
                          {done && tx && <> · <a href={txUrl(tx, onChain)} target="_blank" rel="noreferrer" className="mono small">{shortHex(tx)}</a></>}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
