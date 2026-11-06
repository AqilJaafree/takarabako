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

/// The yield page's headline: the live ETH/USDC price and its move, a chart of
/// the last day or week (a filled line by default, hourly candles on request)
/// with the last price tagged on the axis and a crosshair, and the numbers
/// that matter at a glance.

type View = "line" | "candles";
type Span = "1d" | "7d";
export function MarketHero({
  spot,
  candles: allCandles,
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
  const [view, setView] = useState<View>("line");
  const [span, setSpan] = useState<Span>("7d");
  const candles = span === "1d" ? allCandles.slice(-24) : allCandles;
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
  const days = !inBrowser
    ? []
    : candles
        .map((c, i) => ({ i, d: new Date(c.t * 1000) }))
        .filter(({ d, i }) => (span === "1d" ? d.getHours() % 6 === 0 : d.getHours() === 0) && i > 1 && i < candles.length - 2);
  const dayLabel = (d: Date) =>
    span === "1d" ? d.toLocaleTimeString([], { hour: "numeric" }) : d.toLocaleDateString(undefined, { weekday: "short" });
  // The line view: closes joined, with a fill fading down to the bottom of the plot.
  const linePath = candles.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c.c).toFixed(1)}`).join("");
  const areaPath = candles.length ? `${linePath}L${x(candles.length - 1).toFixed(1)},${PAD.top + plotH}L${x(0).toFixed(1)},${PAD.top + plotH}Z` : "";

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
  const trend = change >= 0 ? "up" : "down";
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
          <p className="label" style={{ margin: 0 }}>ETH / USDC</p>
          <div className="market-price">
            <span className="amount">{usd(spot, 2)}</span>
            <span className={`market-change ${change >= 0 ? "up" : "down"}`}>
              <span aria-hidden="true">{change >= 0 ? "▲" : "▼"}</span> {Math.abs(change).toFixed(2)}%
              <span className="muted"> {span === "1d" ? "24h" : "7d"}</span>
            </span>
          </div>
        </div>
        <div className="mh-controls">
          <div className="mh-seg" role="group" aria-label="Time span">
            {(["1d", "7d"] as Span[]).map((v) => (
              <button key={v} type="button" aria-pressed={span === v} onClick={() => { setSpan(v); setHover(null); }}>{v === "1d" ? "24H" : "7D"}</button>
            ))}
          </div>
          <div className="mh-seg" role="group" aria-label="Chart type">
            {(["line", "candles"] as View[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v === "line" ? "Line" : "Candles"}</button>
            ))}
          </div>
        </div>
      </div>

      <div
        ref={wrap}
        className="market-chart"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`ETH/USDC over the last ${span === "1d" ? "24 hours" : "7 days"}, from ${usd(first, 0)} to ${usd(spot, 0)} (low ${usd(lowest, 0)}, high ${usd(highest, 0)})`}
      >
        {hc && (
          <div className="mh-legend" aria-hidden="true">
            <span className="muted">{inBrowser ? new Date(hc.t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}</span>
            {view === "line" ? (
              <b>{usd(hc.c, 2)}</b>
            ) : (
              <>
                <span>O <b className={up ? "tone-ok" : "tone-bad"}>{hc.o.toFixed(2)}</b></span>
                <span>H <b className={up ? "tone-ok" : "tone-bad"}>{hc.h.toFixed(2)}</b></span>
                <span>L <b className={up ? "tone-ok" : "tone-bad"}>{hc.l.toFixed(2)}</b></span>
                <span>C <b className={up ? "tone-ok" : "tone-bad"}>{hc.c.toFixed(2)}</b></span>
              </>
            )}
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
              <text x={x(i)} y={H - 6} textAnchor="middle" className="mh-tick">{dayLabel(d)}</text>
            </g>
          ))}
          {view === "line" ? (
            <g className={`mh-line ${trend}`}>
              <defs>
                <linearGradient id="mh-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" className="mh-fill-top" />
                  <stop offset="100%" className="mh-fill-bottom" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill="url(#mh-fill)" />
              <path d={linePath} className="mh-stroke" />
            </g>
          ) : (
            candles.map((c, i) => (
              <g key={c.t} className={c.c >= c.o ? "mh-up" : "mh-down"}>
                <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} />
                <rect x={x(i) - cw / 2} y={y(Math.max(c.o, c.c))} width={cw} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
              </g>
            ))
          )}
          <line x1={PAD.left} x2={PAD.left + plotW} y1={y(spot)} y2={y(spot)} className={`mh-last ${trend}`} />
          {view === "line" && candles.length > 0 && <circle cx={x(candles.length - 1)} cy={y(spot)} r={4} className={`mh-now ${trend}`} />}
          {tag(spot, y(spot), `mh-tag ${trend}`)}
          {hover && hc && (
            <g pointerEvents="none">
              <line x1={x(hover.i)} x2={x(hover.i)} y1={PAD.top} y2={PAD.top + plotH} className="mh-cross" />
              {view === "line" ? (
                <circle cx={x(hover.i)} cy={y(hc.c)} r={4} className={`mh-now ${trend}`} />
              ) : (
                <>
                  <line x1={PAD.left} x2={PAD.left + plotW} y1={hover.py} y2={hover.py} className="mh-cross" />
                  {tag(priceAt(hover.py), hover.py, "mh-tag hair")}
                </>
              )}
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
