"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import gsap from "gsap";
import type { Candle, Pool, RiskTier } from "@/lib/types";
import { apy, usd } from "@/lib/format";

/// Quick start: three ready-made ETH/USDC ranges on 1inch Aqua. Each card
/// draws the real week of ETH prices with its range shaded, so "how bold"
/// is something you can see. The projector turns the amount into what it
/// would earn at each tier's estimated APY — with an empty box it previews
/// $100, so the numbers are never blank.

// Risk is ordinal: one gold hue, brighter as risk rises (validated for the
// dark surface; the dimmest step is 3.75:1). Text labels and the risk meter
// carry the order too, so it's never colour alone.
const RAMP: Record<RiskTier, string> = { low: "#8a6a33", medium: "#c4913a", high: "#f2c46a" };
const LEVEL: Record<RiskTier, number> = { low: 1, medium: 2, high: 3 };
const PREVIEW_AMOUNT = 100;

/// A number that rolls to its new value (gsap), formatted by `format`.
function Rolling({ value, format }: { value: number; format: (n: number) => string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef({ v: value });
  useEffect(() => {
    const t = gsap.to(shown.current, {
      v: value,
      duration: 0.6,
      ease: "power2.out",
      onUpdate: () => {
        if (el.current) el.current.textContent = format(shown.current.v);
      },
    });
    return () => { t.kill(); };
  }, [value, format]);
  return <span ref={el}>{format(value)}</span>;
}

const money = (n: number) => (n > 0 && n < 1 ? `$${n.toFixed(3)}` : usd(n));

/// The week's closes as a line, the tier's range as a shaded band, today's
/// price as a dot. A full-range tier's band fills the chart.
function RangeSpark({ candles, tier, spot }: { candles: Candle[]; tier: Pool; spot: number }) {
  const W = 300;
  const H = 84;
  const closes = candles.map((c) => c.c);
  const full = tier.fullRange || tier.priceLowUsd === null || tier.priceHighUsd === null;
  const lo = Math.min(...closes, full ? Infinity : tier.priceLowUsd!);
  const hi = Math.max(...closes, full ? -Infinity : tier.priceHighUsd!);
  const pad = (hi - lo) * 0.08 || 1;
  const y = (v: number) => H - 4 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 8);
  const x = (i: number) => (i / Math.max(1, closes.length - 1)) * W;
  const line = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const top = full ? 0 : y(tier.priceHighUsd!);
  const bottom = full ? H : y(tier.priceLowUsd!);
  const color = RAMP[tier.riskTier];
  return (
    <svg className="range-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} aria-hidden="true">
      <rect x="0" y={top} width={W} height={Math.max(2, bottom - top)} fill={color} opacity="0.2" />
      {!full && (
        <>
          <line x1="0" x2={W} y1={top} y2={top} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={W} y1={bottom} y2={bottom} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </>
      )}
      <path d={line} fill="none" stroke="var(--cream)" strokeOpacity="0.85" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={W - 4} cy={y(spot)} r="4" fill="var(--cream)" stroke="var(--surface)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RiskMeter({ tier }: { tier: RiskTier }) {
  return (
    <span className="risk-meter" aria-label={`Risk ${LEVEL[tier]} of 3`}>
      {[1, 2, 3].map((n) => (
        <span key={n} style={n <= LEVEL[tier] ? { background: RAMP[tier] } : undefined} />
      ))}
    </span>
  );
}

export function QuickStart({
  tiers,
  candles,
  spot,
  balance,
  onOpen,
}: {
  tiers: Pool[];
  candles: Candle[];
  spot: number;
  balance: number;
  onOpen: (tier: RiskTier, amount: number) => Promise<void>;
}) {
  const preview = balance <= 0;
  const cap = preview ? PREVIEW_AMOUNT * 10 : balance;
  const [tier, setTier] = useState<RiskTier>("medium");
  const [wanted, setWanted] = useState(preview ? PREVIEW_AMOUNT : Math.floor(balance * 100) / 100);
  const amount = Math.min(wanted, cap); // the box can shrink while this is open
  const [busy, setBusy] = useState(false);
  const chosen = tiers.find((t) => t.riskTier === tier) ?? tiers[0];
  const yearly = (t: Pool) => (amount * t.apyBps) / 10_000;
  const maxYearly = Math.max(...tiers.map(yearly), 0.0001);
  const range = (t: Pool) =>
    t.fullRange || t.priceLowUsd === null || t.priceHighUsd === null ? "Full range" : `${usd(t.priceLowUsd, 0)} – ${usd(t.priceHighUsd, 0)}`;
  const earnings = useMemo(() => {
    const y = chosen ? yearly(chosen) : 0;
    return { day: y / 365, month: y / 12, year: y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, amount]);

  return (
    <section className="qs">
      <div className="qs-head">
        <h2>Pick how bold to be</h2>
        <p className="muted small">
          Each strategy provides ETH/USDC liquidity on 1inch Aqua and earns a fee on every trade. Narrower ranges earn
          more while ETH stays inside them — and pause when it leaves.
        </p>
      </div>

      <div className="qs-tiers" role="radiogroup" aria-label="Risk level">
        {tiers.map((t) => {
          const on = t.riskTier === tier;
          return (
            <button
              key={t.riskTier}
              role="radio"
              aria-checked={on}
              className={`qs-tier${on ? " is-on" : ""}`}
              style={{ ["--tier" as string]: RAMP[t.riskTier] }}
              onClick={() => setTier(t.riskTier)}
              disabled={busy}
            >
              <span className="qs-tier-top">
                <span className="qs-tier-name">{t.label}</span>
                <span className="qs-check" aria-hidden="true">{on ? "✓" : ""}</span>
              </span>
              <span className="qs-apy amount">~{apy(t.apyBps)}<small> APY</small></span>
              <RangeSpark candles={candles} tier={t} spot={spot} />
              <span className="qs-range small">{range(t)}</span>
              <span className="qs-tier-foot">
                <RiskMeter tier={t.riskTier} />
                <span className="muted small">{(t.feeBps / 100).toFixed(2)}% fee</span>
              </span>
              <span className="qs-desc small muted">{t.description}</span>
            </button>
          );
        })}
      </div>
      <p className="muted small qs-legend">
        <span className="qs-key line" /> ETH, last 7 days <span className="qs-key band" /> where the strategy earns
        <span className="qs-key dot" /> today
      </p>

      <div className="qs-projector">
        <div className="qs-amount">
          <label className="label" htmlFor="qs-amount">{preview ? "Try an amount" : "Amount"}</label>
          <div className="qs-amount-row">
            <span className="qs-dollar">$</span>
            <input
              id="qs-amount"
              className="qs-amount-input amount"
              type="number"
              inputMode="decimal"
              min={0}
              max={cap}
              step="0.01"
              value={Number.isFinite(amount) ? Math.floor(amount * 100) / 100 : ""}
              onChange={(e) => setWanted(Math.min(cap, Math.max(0, Number(e.target.value))))}
            />
            {!preview &&
              [0.25, 0.5, 1].map((f) => (
                <button key={f} type="button" className="btn btn-ghost small chip" onClick={() => setWanted(Math.floor(balance * f * 100) / 100)}>
                  {f === 1 ? "Max" : `${f * 100}%`}
                </button>
              ))}
          </div>
          <input
            className="qs-slider"
            type="range"
            min={0}
            max={cap}
            step={cap / 200 || 1}
            value={amount}
            onChange={(e) => setWanted(Number(e.target.value))}
            aria-label="Amount"
            style={{ ["--fill" as string]: `${cap ? (amount / cap) * 100 : 0}%` }}
          />
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {preview ? "Your box is empty, so this is a preview." : `${usd(balance)} in your box`}
          </p>
        </div>

        <div className="qs-earn" aria-live="polite">
          <p className="label" style={{ margin: 0 }}>With {chosen?.label ?? "this strategy"} you could earn</p>
          <div className="qs-earn-grid">
            <div><span className="qs-earn-num amount"><Rolling value={earnings.day} format={money} /></span><span className="muted small">per day</span></div>
            <div><span className="qs-earn-num amount"><Rolling value={earnings.month} format={money} /></span><span className="muted small">per month</span></div>
            <div className="qs-earn-year"><span className="qs-earn-num amount"><Rolling value={earnings.year} format={money} /></span><span className="muted small">per year</span></div>
          </div>
        </div>

        <div className="qs-compare" role="list" aria-label="Estimated yearly earnings by strategy">
          {tiers.map((t) => (
            <div
              key={t.riskTier}
              role="listitem"
              className={`qs-bar${t.riskTier === tier ? " is-on" : ""}`}
              title={`${t.label}: ${money(yearly(t))} a year at ~${apy(t.apyBps)} APY`}
            >
              <span className="qs-bar-label small">{t.label}</span>
              <span className="qs-bar-track">
                <span style={{ width: `${(yearly(t) / maxYearly) * 100}%`, background: RAMP[t.riskTier] }} />
              </span>
              <span className="qs-bar-value small">{money(yearly(t))}/yr</span>
            </div>
          ))}
        </div>
      </div>

      {preview ? (
        <Link href="/qr" className="btn btn-gold btn-block qs-cta">
          Insert cash at a kiosk to start earning →
        </Link>
      ) : (
        <button
          className="btn btn-gold btn-block qs-cta"
          disabled={busy || !(amount > 0) || amount > balance}
          onClick={async () => {
            setBusy(true);
            await onOpen(tier, amount);
            setBusy(false);
          }}
        >
          {busy ? "Placing your strategy on 1inch Aqua…" : `Put ${usd(amount)} into ${chosen?.label} · ~${apy(chosen?.apyBps ?? 0)} APY`}
        </button>
      )}
      <p className="muted small" style={{ margin: "10px 0 0", textAlign: "center" }}>
        APY is an estimate from the range width, not a promise. Earnings pause while ETH is outside the range.
      </p>
    </section>
  );
}
