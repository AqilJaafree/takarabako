"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Candle } from "@/lib/types";
import { apy, usd } from "@/lib/format";

const H = 230;
const PAD = { top: 10, right: 64, bottom: 22, left: 6 };

/// A "nice" step (1, 2 or 5 × a power of ten) for about `count` ticks over a span.
function niceStep(span: number, count: number) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

/// The yield page's headline: the live ETH/USDC price, its 7-day move and a
/// TradingView-style candlestick chart (hourly candles, a price axis, the last
/// price tagged on the axis, and a crosshair that reads open, high, low and
/// close), with the numbers that matter at a glance.
export function MarketHero({
  spot,
  candles,
  balance,
  bestApyBps,
  liveCount,
  showEstimates = true,
  feeBps = 30,
}: {
  spot: number;
  candles: Candle[];
  balance: number;
  bestApyBps: number;
  liveCount: number;
  /// Return estimates are guesses: they are hidden where real money is at stake.
  showEstimates?: boolean;
  feeBps?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  // Dates and day lines depend on the viewer's timezone, which the server does
  // not know: draw them only in the browser so the server HTML always matches.
  const inBrowser = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [W, setW] = useState(640);
  const [hover, setHover] = useState<{ i: number; py: number } | null>(null);
  const first = candles[0]?.o ?? spot;
  const change = first ? (spot / first - 1) * 100 : 0;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const { lo, hi } = useMemo(() => {
    if (!candles.length) return { lo: spot * 0.99, hi: spot * 1.01 };
    const l = Math.min(spot, ...candles.map((c) => c.l));
    const h = Math.max(spot, ...candles.map((c) => c.h));
    const pad = (h - l) * 0.06 || 1;
    return { lo: l - pad, hi: h + pad };
  }, [candles, spot]);
  const y = (v: number) => PAD.top + plotH * (1 - (v - lo) / (hi - lo));
  const priceAt = (py: number) => lo + (1 - (py - PAD.top) / plotH) * (hi - lo);
  const slot = candles.length ? plotW / candles.length : plotW;
  const x = (i: number) => PAD.left + slot * (i + 0.5);
  const cw = Math.max(1, Math.min(9, slot * 0.64));
  const step = niceStep(hi - lo, 4);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) ticks.push(v);
  const days = !inBrowser ? [] : candles.map((c, i) => ({ i, d: new Date(c.t * 1000) })).filter(({ d, i }) => d.getHours() === 0 && i > 2 && i < candles.length - 2);

  const onMove = (e: React.PointerEvent) => {
    const el = wrap.current;
    if (!el || !candles.length) return;
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < PAD.left || px > PAD.left + plotW) return setHover(null);
    setHover({ i: Math.min(candles.length - 1, Math.max(0, Math.floor((px - PAD.left) / slot))), py: Math.min(PAD.top + plotH, Math.max(PAD.top, e.clientY - r.top)) });
  };

  const hc = hover ? candles[hover.i] : null;
  const last = candles[candles.length - 1];
  const shown = hc ?? last;
  const up = (shown?.c ?? 0) >= (shown?.o ?? 0);
  const lowest = candles.length ? Math.min(...candles.map((c) => c.l)) : spot;
  const highest = candles.length ? Math.max(...candles.map((c) => c.h)) : spot;
  const tag = (v: number, py: number, cls: string) => (
    <g pointerEvents="none">
      <rect x={PAD.left + plotW + 1} y={py - 9} width={PAD.right - 4} height={18} rx={3} className={cls} />
      <text x={PAD.left + plotW + 1 + (PAD.right - 4) / 2} y={py} dy="0.34em" textAnchor="middle" className="mh-tag-text">{usd(v, 2)}</text>
    </g>
  );

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
        className="market-chart"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`ETH/USDC hourly candles for the last 7 days, from ${usd(first, 0)} to ${usd(spot, 0)} (low ${usd(lowest, 0)}, high ${usd(highest, 0)})`}
      >
        {shown && (
          <div className="mh-legend" aria-hidden="true">
            <span className="muted">{inBrowser ? new Date(shown.t * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</span>
            <span>O <b className={up ? "tone-ok" : "tone-bad"}>{shown.o.toFixed(2)}</b></span>
            <span>H <b className={up ? "tone-ok" : "tone-bad"}>{shown.h.toFixed(2)}</b></span>
            <span>L <b className={up ? "tone-ok" : "tone-bad"}>{shown.l.toFixed(2)}</b></span>
            <span>C <b className={up ? "tone-ok" : "tone-bad"}>{shown.c.toFixed(2)}</b></span>
          </div>
        )}
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t} opacity={Math.abs(y(t) - y(spot)) < 12 ? 0.25 : 1}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="mh-grid" />
              <text x={PAD.left + plotW + 8} y={y(t)} dy="0.34em" className="mh-tick">{usd(t, t >= 100 ? 0 : 2)}</text>
            </g>
          ))}
          {days.map(({ i, d }) => (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={PAD.top} y2={PAD.top + plotH} className="mh-grid mh-grid-v" />
              <text x={x(i)} y={H - 6} textAnchor="middle" className="mh-tick">{d.toLocaleDateString(undefined, { weekday: "short" })}</text>
            </g>
          ))}
          {candles.map((c, i) => (
            <g key={c.t} className={c.c >= c.o ? "mh-up" : "mh-down"}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} />
              <rect x={x(i) - cw / 2} y={y(Math.max(c.o, c.c))} width={cw} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
            </g>
          ))}
          <line x1={PAD.left} x2={PAD.left + plotW} y1={y(spot)} y2={y(spot)} className={`mh-last ${change >= 0 ? "up" : "down"}`} />
          {tag(spot, y(spot), `mh-tag ${change >= 0 ? "up" : "down"}`)}
          {hover && hc && (
            <g pointerEvents="none">
              <line x1={x(hover.i)} x2={x(hover.i)} y1={PAD.top} y2={PAD.top + plotH} className="mh-cross" />
              <line x1={PAD.left} x2={PAD.left + plotW} y1={hover.py} y2={hover.py} className="mh-cross" />
              {tag(priceAt(hover.py), hover.py, "mh-tag hair")}
            </g>
          )}
        </svg>
      </div>

      <div className="market-stats">
        <div>
          <span className="label">Your box</span>
          <b className="amount">{usd(balance)}</b>
        </div>
        <div>
          {showEstimates ? (
            <>
              <span className="label">Earn up to</span>
              <b className="amount">~{apy(bestApyBps)} <small>APY</small></b>
            </>
          ) : (
            <>
              <span className="label">Trading fee</span>
              <b className="amount">{(feeBps / 100).toFixed(2)}% <small>per trade</small></b>
            </>
          )}
        </div>
        <div>
          <span className="label">Your strategies</span>
          <b className="amount">{liveCount} <small>live</small></b>
        </div>
      </div>
    </section>
  );
}
