"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WithdrawResult } from "@/lib/types";
import { SEPOLIA_TX, shortHex, usd } from "@/lib/format";
import { TreasureStage } from "@/components/treasure/TreasureStage";
import { useStageDirector } from "@/components/treasure/useStageDirector";

export function WithdrawForm({ balance, positions, wallet }: { balance: number; positions: number; wallet: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const empty = balance <= 0 && positions === 0;
  const { stage, withdraw: burst, say } = useStageDirector(empty ? "Nothing in the box yet." : "Everything goes to your own wallet, no fee.");

  async function withdraw() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/withdraw", { method: "POST" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "withdraw failed");
      setResult(body);
      burst();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "withdraw failed");
      say("Nyaa… the withdraw didn't go through.", "worried");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const scene = <TreasureStage {...stage} balance={result ? 0 : balance} gems={[]} height={280} />;

  if (result) {
    return (
      <>
      {scene}
      <section className="card">
        <div className="notice success">{result.receipt}</div>
        <p className="small muted" style={{ margin: 0 }}>
          Transaction{" "}
          <a href={SEPOLIA_TX(result.vaultTxHash)} target="_blank" rel="noreferrer" className="mono">
            {shortHex(result.vaultTxHash)}
          </a>
        </p>
        {result.tkcashTxHash && (
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            {usd(result.tkcashBurned ?? 0)} of tkCASH cash receipts redeemed ·{" "}
            <a href={SEPOLIA_TX(result.tkcashTxHash)} target="_blank" rel="noreferrer" className="mono">
              {shortHex(result.tkcashTxHash)}
            </a>
          </p>
        )}
      </section>
      </>
    );
  }

  return (
    <>
    {scene}
    <section className="card">
      {error && <div className="notice error">{error}</div>}
      <div className="spread">
        <span className="label">In your box</span>
        <span className="amount" style={{ fontSize: 24, color: "var(--gold)" }}>{usd(balance)}</span>
      </div>
      {positions > 0 && <p className="small muted">Plus {positions} yield position{positions > 1 ? "s" : ""}, closed as part of this.</p>}
      <p className="small muted">
        To wallet <span className="mono">{shortHex(wallet, 10, 8)}</span>
      </p>
      {!confirming ? (
        <button className="btn btn-gold btn-block" disabled={empty} onClick={() => setConfirming(true)}>
          {empty ? "Nothing to withdraw" : "Withdraw everything"}
        </button>
      ) : (
        <div className="row">
          <button className="btn btn-gold" style={{ flex: 1 }} disabled={busy} onClick={withdraw}>
            {busy ? "Sending…" : "Yes, send it to my wallet"}
          </button>
          <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </section>
    </>
  );
}
