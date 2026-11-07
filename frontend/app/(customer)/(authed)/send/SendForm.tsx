"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChainKey, Me, MyWallet, ResolvedRecipient } from "@/lib/types";
import { chainName, txUrl, shortHex, usd } from "@/lib/format";
import { useWalletSend, type PreparedTx } from "@/lib/useWalletSend";
import { useChainPick } from "@/components/NetworkProvider";

type Asset = "balance" | "tkcash";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

/// Looks up a typed label or wallet address (debounced).
export function useResolvedRecipient(input: string, chain: ChainKey) {
  const [state, setState] = useState<{ loading: boolean; result: ResolvedRecipient | null; error: string }>({ loading: false, result: null, error: "" });
  const seq = useRef(0);
  useEffect(() => {
    const q = input.trim().toLowerCase();
    const id = ++seq.current;
    if (q.length < 3) {
      const t = setTimeout(() => id === seq.current && setState({ loading: false, result: null, error: "" }), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }));
      const res = await fetch(`/api/lookup?q=${encodeURIComponent(q)}&chain=${chain}`);
      const json = await res.json().catch(() => ({}));
      if (id !== seq.current) return;
      setState(res.ok ? { loading: false, result: json, error: "" } : { loading: false, result: null, error: json.error ?? "not found" });
    }, 350);
    return () => clearTimeout(t);
  }, [input, chain]);
  return state;
}

export function RecipientField({ value, onChange, resolved }: { value: string; onChange: (v: string) => void; resolved: ReturnType<typeof useResolvedRecipient> }) {
  const r = resolved.result;
  return (
    <div className="name-field">
      <label className="label" htmlFor="to-name">To</label>
      <input
        id="to-name"
        className="input mono"
        placeholder="alice-1a2b or 0x…"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="name-status small">
        {resolved.loading ? (
          <span className="muted">Looking up…</span>
        ) : r ? (
          <>
            <span className="tone-ok">✓ {r.label ?? "wallet"}</span> → <span className="mono">{shortHex(r.address, 8, 6)}</span>
            {r.customer ? <span className="pill ok">Takarabako customer</span> : <span className="pill warn">External wallet</span>}
          </>
        ) : resolved.error ? (
          <span className="tone-bad">{resolved.error}</span>
        ) : (
          <span className="muted">A label from another Takarabako account, or any wallet address.</span>
        )}
      </div>
    </div>
  );
}

export function SendForm({ me, wallet }: { me: Me; wallet: MyWallet }) {
  const router = useRouter();
  const signAndSend = useWalletSend();
  const [chain, setChain] = useChainPick<ChainKey>(wallet.chains.map((c) => c.chain), me.balances[0]?.chain ?? "sepolia");
  const [asset, setAsset] = useState<Asset>("balance");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ text: string; tx: string | null; chain: ChainKey } | null>(null);
  const resolved = useResolvedRecipient(to, chain);
  const r = resolved.result;
  const here = wallet.chains.find((c) => c.chain === chain);
  const tk = here?.tkcash ?? null;
  const boxHere = me.balances.find((b) => b.chain === chain)?.balance ?? 0;
  const available = asset === "balance" ? boxHere : tk?.balance ?? 0;
  const dailyLeft = tk?.dailyLimit != null ? Math.max(0, tk.dailyLimit - tk.spentToday) : null;
  const value = Number(amount);
  const target = r ? r.label ?? shortHex(r.address, 8, 6) : "";

  const limitLeft = wallet.limit?.limited ? wallet.limit.leftUsd : null;
  const problem = limitLeft !== null && value > limitLeft
    ? `You can move ${usd(wallet.limit!.limitUsd, 0)} a day, and ${usd(limitLeft)} is left today.`
    : !r
    ? null
    : asset === "balance" && !r.customer
      ? "Box balance can only go to another Takarabako box."
      : asset === "tkcash" && r.tkcashAllowlisted === false
        ? "This wallet can't hold tkCASH, only registered Takarabako wallets can."
        : r.address.toLowerCase() === wallet.wallet.toLowerCase()
          ? "That's your own account."
          : asset === "tkcash" && dailyLeft !== null && value > dailyLeft
            ? `tkCASH transfers are limited to ${usd(tk!.dailyLimit)} a day, and ${usd(dailyLeft)} is left today.`
            : null;

  async function send() {
    if (!r) return;
    setBusy(true);
    setError("");
    setDone(null);
    try {
      if (asset === "balance") {
        const res = await post<{ txHash: string }>("/api/send/balance", { to: r.query, amount: value, chain });
        setDone({ text: `Sent ${usd(value)} from your ${chainName(chain)} box to ${target}`, tx: res.txHash, chain });
      } else {
        const prep = await post<{ tx: PreparedTx; from: string }>("/api/send/tkcash/prepare", { to: r.query, amount: value, chain });
        const hash = await signAndSend(prep.tx, prep.from, `Send ${value} tkCASH to ${target} on ${chainName(chain)}`);
        await post("/api/send/tkcash/confirm", { txHash: hash, to: r.label ?? r.query, chain });
        setDone({ text: `Sent ${value} tkCASH to ${target} from your own wallet on ${chainName(chain)}`, tx: hash, chain });
      }
      setAmount("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      {wallet.chains.length > 1 && (
        <div className="yield-tabs" role="tablist" aria-label="Chain">
          {wallet.chains.map((c) => (
            <button key={c.chain} role="tab" aria-selected={chain === c.chain} className={chain === c.chain ? "is-on" : ""} onClick={() => setChain(c.chain)}>
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="yield-tabs" role="tablist" aria-label="What to send">
        <button role="tab" aria-selected={asset === "balance"} className={asset === "balance" ? "is-on" : ""} onClick={() => setAsset("balance")}>
          Box balance <span className="muted small">{usd(boxHere)}</span>
        </button>
        <button role="tab" aria-selected={asset === "tkcash"} className={asset === "tkcash" ? "is-on" : ""} onClick={() => setAsset("tkcash")}>
          tkCASH <span className="muted small">{tk ? `${tk.balance.toFixed(2)} in your wallet` : "unavailable"}</span>
        </button>
      </div>

      <p className="muted small">
        {asset === "balance"
          ? `Moves money from your ${chainName(chain)} box to theirs straight away. Takarabako handles it, so there's no gas to pay.`
          : "tkCASH lives in your own wallet, so you sign this transfer yourself. The token's rules apply on-chain: both wallets must be registered, and there's a daily limit."}
      </p>

      <RecipientField value={to} onChange={setTo} resolved={resolved} />

      <label className="label" htmlFor="send-amount" style={{ display: "block", marginTop: 14 }}>Amount</label>
      <div className="row" style={{ flexWrap: "nowrap", marginTop: 6 }}>
        <input id="send-amount" className="input" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ margin: 0 }} />
        <button type="button" className="btn btn-ghost small chip" onClick={() => setAmount(String(Math.floor(available * 100) / 100))}>Max</button>
      </div>
      <p className="muted small" style={{ margin: "4px 0 0" }}>
        {usd(available)} available on {chainName(chain)}
        {asset === "tkcash" && dailyLeft !== null && ` · ${usd(dailyLeft)} of today's ${usd(tk!.dailyLimit)} limit left`}
        {asset === "tkcash" && here?.native != null && ` · wallet gas ${here.native.toFixed(4)} ${here.nativeSymbol}`}
      </p>

      {problem && <div className="notice pending" style={{ marginTop: 12 }}>{problem}</div>}
      {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}
      {done && (
        <div className="notice success" style={{ marginTop: 12 }}>
          {done.text}
          {done.tx && (
            <> · <a href={txUrl(done.tx, done.chain)} target="_blank" rel="noreferrer" className="mono">{shortHex(done.tx)}</a></>
          )}
        </div>
      )}

      <button
        className="btn btn-gold btn-block"
        style={{ marginTop: 14 }}
        disabled={busy || !r || Boolean(problem) || !(value > 0) || value > available}
        onClick={send}
      >
        {busy ? (asset === "tkcash" ? "Waiting for your wallet…" : "Sending…") : r ? `Send ${value > 0 ? (asset === "tkcash" ? `${value} tkCASH` : usd(value)) : ""} to ${target}` : "Enter a label or address"}
      </button>
    </section>
  );
}
