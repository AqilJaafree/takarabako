"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OpenedPosition, Pool, Position, RiskTier } from "@/lib/types";
import { apy, usd } from "@/lib/format";
import { TreasureStage } from "@/components/treasure/TreasureStage";
import { useStageDirector } from "@/components/treasure/useStageDirector";

// The bubble keeps to a sentence or two; the full rationale is shown below.
const bubble = (text: string) => (text.length > 170 ? `${text.slice(0, 167).trimEnd()}…` : text);

function range(p: Pool): string {
  if (p.fullRange || p.priceLowUsdc == null || p.priceHighUsdc == null) return "Full range";
  return `${usd(p.priceLowUsdc)} – ${usd(p.priceHighUsdc)}`;
}

export function YieldPicker({ balance, pools, positions }: { balance: number; pools: Pool[]; positions: Position[] }) {
  const router = useRouter();
  const [tier, setTier] = useState<RiskTier | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<OpenedPosition | null>(null);
  const { stage, say } = useStageDirector(
    balance > 0 ? "Pick a risk level — I'll tell you why it fits." : "Your box is empty. Feed me a note at the kiosk first!",
  );
  const gems = [
    ...positions.map((p) => ({ id: p.positionId, riskTier: p.riskTier, apyBps: p.apyBps })),
    ...(opened && tier ? [{ id: opened.positionId, riskTier: tier, apyBps: opened.apyBps }] : []),
  ];

  async function open() {
    if (!tier) return;
    setBusy(true);
    setError("");
    say(`Looking at the ${tier}-risk pool…`, "thinking", 0);
    try {
      const res = await fetch("/api/yield", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ riskLevel: tier, amount: balance }),
      });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "couldn't open the position");
      setOpened(body);
      say(bubble(body.rationale ?? `Done! ${body.pair} at ${apy(body.apyBps)} APY.`), "happy", 0);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't open the position");
      say("Hmm, that didn't work. Try again?", "worried");
    } finally {
      setBusy(false);
    }
  }

  const scene = <TreasureStage {...stage} balance={balance} gems={gems} height={300} />;

  if (opened) {
    return (
      <>
      {scene}
      <section className="card">
        <div className="notice success">Position opened: {opened.pair} at {apy(opened.apyBps)} APY</div>
        <div className="ens">{opened.ensName}</div>
        {opened.rationale && <p className="speech">{opened.rationale}</p>}
      </section>
      </>
    );
  }

  return (
    <>
      {scene}
      {positions.length > 0 && (
        <div className="notice">
          You already have {positions.length} open position{positions.length > 1 ? "s" : ""}. They’re listed on{" "}
          <Link href="/">My box</Link>.
        </div>
      )}
      {balance <= 0 && <div className="notice">Your box is empty. Insert cash at a kiosk first.</div>}
      {error && <div className="notice error">{error}</div>}
      <div className="tiers" role="group" aria-label="Risk level">
        {pools.map((p) => (
          <button
            key={p.riskTier}
            className="btn tier"
            data-tier={p.riskTier}
            aria-pressed={tier === p.riskTier}
            onClick={() => setTier(p.riskTier)}
            disabled={balance <= 0 || busy}
          >
            <span className="spread">
              <span className="tier-name">{p.riskTier} risk</span>
              <span className="amount" style={{ color: "var(--gold)" }}>{apy(p.apyBps)} APY</span>
            </span>
            <span className="small muted">
              {p.pair.replace("/", " / ")} · {(p.feeBps / 100).toFixed(2)}% fee · {range(p)}
            </span>
          </button>
        ))}
      </div>
      <button className="btn btn-gold btn-block" style={{ marginTop: 16 }} disabled={!tier || busy || balance <= 0} onClick={open}>
        {busy ? "The agent is placing your position…" : tier ? `Put ${usd(balance)} in the ${tier}-risk pool` : "Pick a risk level"}
      </button>
    </>
  );
}
