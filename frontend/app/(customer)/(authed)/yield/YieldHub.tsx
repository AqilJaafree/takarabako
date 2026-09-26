"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Market, PositionView, Preview, RiskTier, Shape } from "@/lib/types";
import { apy, usd } from "@/lib/format";
import { TreasureStage } from "@/components/treasure/TreasureStage";
import { useStageDirector } from "@/components/treasure/useStageDirector";
import { RangeChart } from "./RangeChart";
import { MarketHero } from "./MarketHero";
import { QuickStart } from "./QuickStart";
import { NameField, useResolvedName } from "../send/SendForm";
import { useWalletSend, type PreparedTx } from "@/lib/useWalletSend";

// The bubble keeps to a sentence or two; the full rationale is shown below.
const bubble = (text: string) => (text.length > 170 ? `${text.slice(0, 167).trimEnd()}…` : text);

type Tab = "quick" | "advanced";
type AdvShape = Exclude<Shape, "full">;

const signedPct = (price: number, spot: number) => {
  const v = (price / spot - 1) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("log in first"), { status: 401 });
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

export function YieldHub({ balance, market, positions: initialPositions }: { balance: number; market: Market; positions: PositionView[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("quick");
  const [positions, setPositions] = useState(initialPositions);
  const [box, setBox] = useState(balance);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; ens?: string; rationale?: string | null } | null>(null);
  const open = positions.filter((p) => p.status === "open");
  const { stage, say } = useStageDirector(
    box > 0 ? "Quick start picks a range for you — or go Advanced and draw your own." : "Your box is empty. Feed me a note at the kiosk first!",
  );
  const gems = open.map((p) => ({ id: p.id, riskTier: (p.mode === "advanced" ? "high" : p.mode) as RiskTier, apyBps: p.apyEstBps }));

  const refresh = useCallback(async () => {
    const [pos, me] = await Promise.all([fetch("/api/yield/positions"), fetch("/api/me")]);
    if (pos.ok) setPositions(((await pos.json()) as { positions: PositionView[] }).positions);
    if (me.ok) setBox(((await me.json()) as { balance: number }).balance);
  }, []);

  const onFail = (e: unknown) => {
    if ((e as { status?: number }).status === 401) return router.replace("/login");
    setError(e instanceof Error ? e.message : "something went wrong");
    say("Hmm, that didn't work. Try again?", "worried");
  };

  const onOpened = async (label: string, body: { ensName?: string; rationale?: string | null }) => {
    setNotice({ text: `${label} position opened`, ens: body.ensName, rationale: body.rationale });
    say(bubble(body.rationale ?? `Done! Your ${label} position is live on 1inch Aqua.`), "happy", 0);
    await refresh();
    router.refresh();
  };

  async function close(p: PositionView) {
    setError("");
    try {
      const r = await postJson<{ value: number; closeTx: string | null }>(`/api/yield/positions/${p.id}/close`, {});
      setNotice({ text: `Closed — ${usd(r.value)} is back in your box` });
      say(`${usd(r.value)} back in the box!`, "happy");
      await refresh();
      router.refresh();
    } catch (e) {
      onFail(e);
    }
  }

  return (
    <>
      <MarketHero
        spot={market.spot}
        candles={market.candles}
        balance={box}
        bestApyBps={Math.max(...market.tiers.map((t) => t.apyBps), market.advanced.apyEstBps)}
        liveCount={open.length}
      />
      <TreasureStage {...stage} balance={box} gems={gems} height={240} />
      {error && <div className="notice error">{error}</div>}
      {notice && (
        <div className="notice success">
          {notice.text}
          {notice.ens && <div className="ens small">{notice.ens}</div>}
          {notice.rationale && <p className="speech small" style={{ margin: "8px 0 0" }}>{notice.rationale}</p>}
        </div>
      )}

      {open.length > 0 && (
        <PositionsList
          positions={open}
          onClose={close}
          onGiven={async (p, to) => {
            setNotice({ text: `${p.label} position given to ${to} — its ENS deed is in their wallet now` });
            say(`Sent to ${to}!`, "happy");
            await refresh();
            router.refresh();
          }}
          onError={onFail}
        />
      )}

      <div className="yield-tabs" role="tablist" aria-label="Yield mode">
        <button role="tab" aria-selected={tab === "quick"} className={tab === "quick" ? "is-on" : ""} onClick={() => setTab("quick")}>
          Quick start <span className="muted small">for beginners</span>
        </button>
        <button role="tab" aria-selected={tab === "advanced"} className={tab === "advanced" ? "is-on" : ""} onClick={() => setTab("advanced")}>
          Advanced <span className="muted small">draw your range</span>
        </button>
      </div>

      {tab === "quick" ? (
        <QuickStart
          tiers={market.tiers}
          candles={market.candles}
          spot={market.spot}
          balance={box}
          onOpen={async (tier, amount) => {
            setError("");
            say(`Placing your ${tier}-risk strategy on 1inch Aqua…`, "thinking", 0);
            try {
              const body = await postJson<{ ensName: string; rationale: string; pair: string }>("/api/yield", { riskLevel: tier, amount });
              await onOpened(market.tiers.find((t) => t.riskTier === tier)?.label ?? tier, body);
            } catch (e) {
              onFail(e);
            }
          }}
        />
      ) : (
        <Advanced
          market={market}
          balance={box}
          onOpen={async (req) => {
            setError("");
            say("Shipping your strategies to 1inch Aqua…", "thinking", 0);
            try {
              const body = await postJson<{ ensName: string }>("/api/yield/advanced", req);
              await onOpened(`Advanced ${req.shape === "bidask" ? "Bid-Ask" : req.shape === "curve" ? "Curve" : "Spot"}`, body);
            } catch (e) {
              onFail(e);
            }
          }}
        />
      )}
    </>
  );
}

function AmountPicker({ balance, amount, setAmount }: { balance: number; amount: number; setAmount: (n: number) => void }) {
  return (
    <div className="amount-picker">
      <label className="label" htmlFor="yield-amount">Amount</label>
      <div className="row">
        <input
          id="yield-amount"
          className="input"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={Number.isFinite(amount) ? Math.floor(amount * 100) / 100 : ""}
          onChange={(e) => setAmount(Math.min(balance, Math.max(0, Number(e.target.value))))}
        />
        {[0.25, 0.5, 1].map((f) => (
          <button key={f} type="button" className="btn btn-ghost small chip" onClick={() => setAmount(Math.floor(balance * f * 100) / 100)}>
            {f === 1 ? "Max" : `${f * 100}%`}
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: "4px 0 0" }}>{usd(balance)} available in your box</p>
    </div>
  );
}

const SHAPES: Array<{ id: AdvShape; name: string; hint: string }> = [
  { id: "spot", name: "Spot", hint: "Even liquidity across the range" },
  { id: "curve", name: "Curve", hint: "Most liquidity near today's price" },
  { id: "bidask", name: "Bid-Ask", hint: "Most at the edges — buy dips, sell rips" },
];

function Advanced({
  market,
  balance,
  onOpen,
}: {
  market: Market;
  balance: number;
  onOpen: (req: { amount: number; shape: AdvShape; priceMin: number; priceMax: number }) => Promise<void>;
}) {
  const spot = market.spot;
  const limits = { lo: market.advanced.minPrice, hi: market.advanced.maxPrice };
  const [shape, setShape] = useState<AdvShape>("curve");
  const [range, setRange] = useState({ min: spot * 0.8, max: spot * 1.2 });
  const [wanted, setAmount] = useState(Math.floor(balance * 100) / 100);
  const amount = Math.min(wanted, balance); // the box can shrink while this is open
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState(false);

  const presets: Array<{ name: string; min: number; max: number }> = [
    { name: "Around price ±15%", min: spot * 0.85, max: spot * 1.15 },
    { name: "Wide ±50%", min: spot * 0.5, max: spot * 1.5 },
    { name: "Buy the dip · USDC only (to −90%)", min: limits.lo, max: spot * 0.97 },
    { name: "Sell the rally · ETH only", min: spot * 1.03, max: spot * 2 },
  ];

  // Preview the split (debounced while dragging).
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const p = await postJson<Preview>("/api/yield/preview", { amount: amount > 0 ? amount : 100, shape, priceMin: range.min, priceMax: range.max });
        if (id === seq.current) {
          setPreview(p);
          setPreviewError("");
        }
      } catch (e) {
        if (id === seq.current) setPreviewError(e instanceof Error ? e.message : "preview failed");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [shape, range.min, range.max, amount]);

  const side = preview?.side ?? "both";
  const totals = preview?.bins.reduce((s, b) => ({ eth: s.eth + b.eth, usdc: s.usdc + b.usdc }), { eth: 0, usdc: 0 });

  return (
    <section className="card">
      <h2>Draw your range</h2>
      <p className="muted small">
        Liquidity only earns while ETH trades inside your range. A range entirely below today&apos;s price holds only
        USDC and buys ETH as it falls; entirely above, it holds ETH and sells as it rises.
      </p>

      <div className="shape-picker" role="radiogroup" aria-label="Liquidity shape">
        {SHAPES.map((s) => (
          <button key={s.id} role="radio" aria-checked={shape === s.id} className={shape === s.id ? "is-on" : ""} onClick={() => setShape(s.id)}>
            <ShapeIcon shape={s.id} />
            <b>{s.name}</b>
            <span className="muted small">{s.hint}</span>
          </button>
        ))}
      </div>

      <RangeChart
        candles={market.candles}
        spot={spot}
        min={range.min}
        max={range.max}
        limits={limits}
        bins={preview?.bins ?? []}
        onChange={(min, max) => setRange({ min, max })}
      />

      <div className="row presets">
        {presets.map((p) => (
          <button key={p.name} type="button" className="btn btn-ghost small chip" onClick={() => setRange({ min: p.min, max: p.max })}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="range-inputs">
        <label>
          <span className="label">Lower price</span>
          <input
            className="input"
            type="number"
            value={Math.round(range.min)}
            min={Math.ceil(limits.lo)}
            onChange={(e) => setRange((r) => ({ ...r, min: Math.max(limits.lo, Number(e.target.value) || r.min) }))}
          />
          <span className="muted small">{signedPct(range.min, spot)} from now</span>
        </label>
        <label>
          <span className="label">Upper price</span>
          <input
            className="input"
            type="number"
            value={Math.round(range.max)}
            max={Math.floor(limits.hi)}
            onChange={(e) => setRange((r) => ({ ...r, max: Math.min(limits.hi, Number(e.target.value) || r.max) }))}
          />
          <span className="muted small">{signedPct(range.max, spot)} from now</span>
        </label>
      </div>

      <AmountPicker balance={balance} amount={amount} setAmount={setAmount} />

      <div className="preview-box">
        {previewError ? (
          <span className="tone-bad small">{previewError}</span>
        ) : preview && totals ? (
          <>
            <span className={`pill ${side === "both" ? "ok" : "warn"}`}>
              {side === "usdc" ? "One-sided · USDC (bid)" : side === "eth" ? "One-sided · ETH (ask)" : "Two-sided · in range now"}
            </span>
            <span className="small">
              {preview.bins.length} strateg{preview.bins.length === 1 ? "y" : "ies"} · {totals.usdc.toFixed(2)} USDC + {totals.eth.toFixed(5)} ETH
              {amount > 0 ? "" : " (preview for $100)"}
            </span>
            <span className="muted small">~{apy(market.advanced.apyEstBps)} APY estimate · {(market.advanced.feeBps / 100).toFixed(2)}% fee</span>
          </>
        ) : (
          <span className="muted small">Working out the split…</span>
        )}
      </div>

      <button
        className="btn btn-gold btn-block"
        disabled={busy || !(amount > 0) || amount > balance || Boolean(previewError)}
        onClick={async () => {
          setBusy(true);
          await onOpen({ amount, shape, priceMin: range.min, priceMax: range.max });
          setBusy(false);
        }}
      >
        {busy ? "Shipping strategies to 1inch Aqua…" : `Open ${usd(amount)} · ${usd(range.min, 0)} – ${usd(range.max, 0)}`}
      </button>
    </section>
  );
}

function ShapeIcon({ shape }: { shape: AdvShape }) {
  const bars = shape === "spot" ? [3, 3, 3, 3, 3] : shape === "curve" ? [1, 2, 4, 2, 1] : [4, 2, 1, 2, 4];
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true" className="shape-icon">
      {bars.map((h, i) => (
        <rect key={i} x={2 + i * 8.4} y={22 - h * 5} width="6" height={h * 5} rx="2" className={i < 2 ? "usdc" : i > 2 ? "eth" : "mid"} />
      ))}
    </svg>
  );
}

function PositionsList({
  positions,
  onClose,
  onGiven,
  onError,
}: {
  positions: PositionView[];
  onClose: (p: PositionView) => Promise<void>;
  onGiven: (p: PositionView, to: string) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [closing, setClosing] = useState<string | null>(null);
  const [giving, setGiving] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Your strategies</h2>
      <ul className="pos-list">
        {positions.map((p) => {
          const pnl = p.pnlUsd ?? 0;
          const hasRange = p.priceMin !== null && p.priceMax !== null;
          // Where today's price sits in (or around) the range, on a log scale.
          const lo = hasRange ? Math.min(p.priceMin!, p.spot) / 1.05 : 0;
          const hi = hasRange ? Math.max(p.priceMax!, p.spot) * 1.05 : 1;
          const at = (v: number) => ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100;
          return (
            <li key={p.id}>
              <div className="spread">
                <b>{p.label}</b>
                <span className={`pill ${p.inRange ? "ok" : "warn"}`}>{p.inRange ? "Earning · in range" : "Out of range"}</span>
              </div>
              <div className="spread pos-numbers">
                <span className="amount">{usd(p.valueUsd)}</span>
                <span className={`small ${pnl >= 0 ? "tone-ok" : "tone-bad"}`}>
                  {pnl >= 0 ? "+" : "−"}{usd(Math.abs(pnl), 4)} since opening
                </span>
              </div>
              {hasRange ? (
                <div className="pos-range" aria-label={`Range ${usd(p.priceMin, 0)} to ${usd(p.priceMax, 0)}, ETH now ${usd(p.spot, 0)}`}>
                  <span className="pos-range-band" style={{ left: `${at(p.priceMin!)}%`, width: `${at(p.priceMax!) - at(p.priceMin!)}%` }} />
                  <span className="pos-range-now" style={{ left: `${at(p.spot)}%` }} />
                </div>
              ) : null}
              <p className="muted small" style={{ margin: "6px 0 8px" }}>
                {hasRange ? `${usd(p.priceMin, 0)} – ${usd(p.priceMax, 0)}` : "Full range"} · ETH now {usd(p.spot, 0)} · {p.eth.toFixed(5)} ETH + {p.usdc.toFixed(2)} USDC ·{" "}
                {p.bins.length} strateg{p.bins.length === 1 ? "y" : "ies"}
              </p>
              <div className="row">
                <button
                  className="btn btn-ghost small"
                  disabled={closing === p.id}
                  onClick={async () => {
                    setClosing(p.id);
                    await onClose(p);
                    setClosing(null);
                  }}
                >
                  {closing === p.id ? "Closing…" : "Close & return to box"}
                </button>
                <button className="btn btn-ghost small" onClick={() => setGiving(giving === p.id ? null : p.id)}>
                  {giving === p.id ? "Cancel" : "Give to…"}
                </button>
              </div>
              {giving === p.id && <GiveForm position={p} onGiven={(to) => { setGiving(null); return onGiven(p, to); }} onError={onError} />}
            </li>
          );
        })}
      </ul>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Strategies run on <a href={`https://sepolia.etherscan.io/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`} target="_blank" rel="noreferrer">1inch Aqua</a> —
        the tokens stay in the Takarabako treasury; Aqua tracks each strategy&apos;s share.
      </p>
    </section>
  );
}


/// Hands a position to someone else by sending its deed — the position's ENS
/// v2 name token — from the customer's own wallet to the recipient's.
function GiveForm({ position, onGiven, onError }: { position: PositionView; onGiven: (to: string) => Promise<void>; onError: (e: unknown) => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const resolved = useResolvedName(to);
  const signAndSend = useWalletSend();
  const r = resolved.result;
  const deed = `aqua-${position.id.replace(/-/g, "").slice(0, 8)}`;

  return (
    <div className="give-form">
      <p className="muted small" style={{ margin: "10px 0 6px" }}>
        This position&apos;s deed is the ENS name <span className="mono">{deed}.takarabako.eth</span>, held in your wallet. Send it and the
        position — its value and future fees — belongs to them.
      </p>
      <NameField value={to} onChange={setTo} resolved={resolved} />
      {r && !r.customer && <div className="notice pending" style={{ marginTop: 10 }}>That&apos;s not a Takarabako customer — they&apos;d hold the deed but couldn&apos;t manage the position here.</div>}
      <button
        className="btn btn-gold btn-block"
        style={{ marginTop: 10 }}
        disabled={busy || !r}
        onClick={async () => {
          if (!r) return;
          setBusy(true);
          try {
            const prep = await postJson<{ tx: PreparedTx; from: string; deed: string }>(`/api/yield/positions/${position.id}/give/prepare`, { to: r.name });
            const hash = await signAndSend(prep.tx, prep.from, `Give ${prep.deed} to ${r.name}`);
            await postJson(`/api/yield/positions/${position.id}/give/confirm`, { txHash: hash });
            await onGiven(r.name);
          } catch (e) {
            onError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting for your wallet…" : r ? `Give this position to ${r.name}` : "Enter a name"}
      </button>
    </div>
  );
}
