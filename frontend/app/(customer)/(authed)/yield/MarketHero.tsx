"use client";

import { useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/types";
import { apy, usd } from "@/lib/format";

const H = 96;

/// The yield page's headline: live ETH/USDC price, its 7-day move, a week
/// sparkline with a hover crosshair, and the numbers that matter at a glance.
export function MarketHero({
  spot,
  candles,
  balance,
  bestApyBps,
  liveCount,
}: {
  spot: number;
  candles: Candle[];
  balance: number;
  bestApyBps: number;
  liveCount: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; w: number } | null>(null);
  const closes = useMemo(() => candles.map((c) => c.c), [candles]);
  const first = closes[0] ?? spot;
  const change = first ? (spot / first - 1) * 100 : 0;

  const { path, area, lo, hi } = useMemo(() => {
    if (closes.length < 2) return { path: "", area: "", lo: spot, hi: spot };
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    const pad = (hi - lo) * 0.12 || 1;
    const y = (v: number) => H - 6 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 12);
    const x = (i: number) => (i / (closes.length - 1)) * 1000;
    const path = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    return { path, area: `${path}L1000,${H}L0,${H}Z`, lo, hi };
  }, [closes, spot]);

  const onMove = (e: React.PointerEvent) => {
    const el = wrap.current;
    if (!el || closes.length < 2) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const i = Math.round(f * (closes.length - 1));
    setHover({ i, x: (i / (closes.length - 1)) * r.width, w: r.width });
  };

  const hovered = hover ? candles[hover.i] : null;
  const hoverY = hover && closes.length > 1
    ? (() => {
        const pad = (hi - lo) * 0.12 || 1;
        return H - 6 - ((closes[hover.i] - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 12);
      })()
    : 0;

  return (
    <section className="market-hero">
      <div className="market-hero-top">
        <div>
          <p className="label" style={{ margin: 0 }}>ETH / USDC · 1inch Aqua</p>
          <div className="market-price">
            <span className="amount">{usd(spot, 2)}</span>
            <span className={`market-change ${change >= 0 ? "up" : "down"}`}>
              <span aria-hidden="true">{change >= 0 ? "▲" : "▼"}</span> {Math.abs(change).toFixed(2)}%
              <span className="muted"> 7d</span>
            </span>
          </div>
        </div>
        <span className="pill ok market-live">Live</span>
      </div>

      <div
        ref={wrap}
        className="market-spark"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`ETH price over the last 7 days, from ${usd(first, 0)} to ${usd(spot, 0)} (low ${usd(lo, 0)}, high ${usd(hi, 0)})`}
      >
        <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" height={H} width="100%" aria-hidden="true">
          <defs>
            <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#spark-fill)" />
          <path d={path} fill="none" stroke="var(--gold)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        {hover && hovered && (
          <>
            <span className="spark-cross" style={{ left: hover.x }} />
            <span className="spark-dot" style={{ left: hover.x, top: hoverY }} />
            <span className={`spark-tip${hover.x > hover.w * 0.7 ? " left" : ""}`} style={{ left: hover.x }}>
              <b>{usd(hovered.c, 2)}</b>
              <span>{new Date(hovered.t * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
            </span>
          </>
        )}
      </div>

      <div className="market-stats">
        <div>
          <span className="label">Your box</span>
          <b className="amount">{usd(balance)}</b>
        </div>
        <div>
          <span className="label">Earn up to</span>
          <b className="amount">~{apy(bestApyBps)} <small>APY</small></b>
        </div>
        <div>
          <span className="label">Your strategies</span>
          <b className="amount">{liveCount} <small>live</small></b>
        </div>
      </div>
    </section>
  );
}
