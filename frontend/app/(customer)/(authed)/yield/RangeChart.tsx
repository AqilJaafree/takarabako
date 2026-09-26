"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Candle, PreviewBin } from "@/lib/types";
import { usd } from "@/lib/format";

/// The advanced range picker: a week of ETH/USD on a log price axis (so a
/// −90% range and the week's wiggle fit together), the chosen range as a
/// band with two draggable price lines, the current price, and a side
/// histogram of how the liquidity would be split (USDC below the price,
/// ETH above). Colours are the chart tokens in globals.css (.range-chart).

const H = 330;
const PAD = { top: 16, right: 104, bottom: 26, left: 58 };
const HIST_W = 82;

interface Props {
  candles: Candle[];
  spot: number;
  min: number;
  max: number;
  limits: { lo: number; hi: number }; // allowed range (−90% … +300%)
  bins: PreviewBin[];
  onChange: (min: number, max: number) => void;
}

type Drag = { kind: "min" | "max" | "band"; startY: number; startMin: number; startMax: number; domain: { lo: number; hi: number } } | null;

const pct = (p: number, spot: number) => {
  const v = (p / spot - 1) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(v > -10 && v < 10 ? 1 : 0)}%`;
};

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * i) / (count - 1));
    const mag = 10 ** Math.floor(Math.log10(v));
    out.push(Math.round(v / (mag / 2)) * (mag / 2));
  }
  return [...new Set(out)];
}

export function RangeChart({ candles, spot, min, max, limits, bins, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const [drag, setDrag] = useState<Drag>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverBin, setHoverBin] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(340, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The price axis fits the week and the range; it's frozen while dragging
  // so the line under the pointer doesn't slide away.
  const liveDomain = useMemo(() => {
    const lows = candles.map((c) => c.l);
    const highs = candles.map((c) => c.h);
    const lo = Math.min(min, spot, ...lows) / 1.06;
    const hi = Math.max(max, spot, ...highs) * 1.06;
    return { lo, hi };
  }, [candles, min, max, spot]);
  const domain = drag ? drag.domain : liveDomain;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const lnLo = Math.log(domain.lo);
  const lnHi = Math.log(domain.hi);
  const y = useCallback((p: number) => PAD.top + plotH * (1 - (Math.log(p) - lnLo) / (lnHi - lnLo)), [plotH, lnLo, lnHi]);
  const priceAt = useCallback((py: number) => Math.exp(lnLo + (1 - (py - PAD.top) / plotH) * (lnHi - lnLo)), [plotH, lnLo, lnHi]);
  const x = (i: number) => PAD.left + (candles.length > 1 ? (i / (candles.length - 1)) * plotW : plotW / 2);

  const line = candles.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c.c).toFixed(1)}`).join(" ");
  const area = candles.length ? `${line} L${x(candles.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z` : "";

  // Keep the range inside the limits and at least 2% wide.
  const clamp = useCallback(
    (lo: number, hi: number, moving: "min" | "max" | "band") => {
      const gap = 1.02;
      if (moving === "band") {
        const ratio = hi / lo;
        const a = Math.max(limits.lo, Math.min(lo, limits.hi / ratio));
        return [a, a * ratio] as const;
      }
      let a = Math.max(limits.lo, Math.min(lo, limits.hi / gap));
      let b = Math.min(limits.hi, Math.max(hi, limits.lo * gap));
      if (moving === "min") a = Math.min(a, b / gap);
      else b = Math.max(b, a * gap);
      return [a, b] as const;
    },
    [limits],
  );

  const svgRef = useRef<SVGSVGElement>(null);
  const localY = (e: React.PointerEvent) => e.clientY - (svgRef.current?.getBoundingClientRect().top ?? 0);

  function startDrag(kind: "min" | "max" | "band", e: React.PointerEvent) {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setHoverIdx(null);
    setDrag({ kind, startY: localY(e), startMin: min, startMax: max, domain: liveDomain });
  }

  function moveDrag(e: React.PointerEvent) {
    if (!drag) return;
    const py = localY(e);
    if (drag.kind === "band") {
      const factor = priceAt(py) / priceAt(drag.startY);
      const [a, b] = clamp(drag.startMin * factor, drag.startMax * factor, "band");
      onChange(a, b);
    } else {
      const p = priceAt(Math.max(PAD.top, Math.min(PAD.top + plotH, py)));
      const [a, b] = drag.kind === "min" ? clamp(p, max, "min") : clamp(min, p, "max");
      onChange(a, b);
    }
  }

  function nudge(kind: "min" | "max", e: React.KeyboardEvent) {
    const step = e.shiftKey ? 1.05 : 1.01;
    const f = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? 1 / step : 0;
    if (!f) return;
    e.preventDefault();
    const [a, b] = kind === "min" ? clamp(min * f, max, "min") : clamp(min, max * f, "max");
    onChange(a, b);
  }

  function hover(e: React.PointerEvent) {
    if (drag || !candles.length) return;
    const px = e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
    if (px < PAD.left || px > PAD.left + plotW) return setHoverIdx(null);
    setHoverIdx(Math.round(((px - PAD.left) / plotW) * (candles.length - 1)));
  }

  const maxBinUsd = Math.max(0.0001, ...bins.map((b) => b.usd));
  const histX = PAD.left + plotW + 14;
  const ticks = niceTicks(domain.lo, domain.hi);
  const dayTicks = candles
    .map((c, i) => ({ i, d: new Date(c.t * 1000) }))
    .filter(({ d, i }) => d.getHours() === 0 && i > 3 && i < candles.length - 3);

  const hc = hoverIdx !== null ? candles[hoverIdx] : null;
  const hb = hoverBin !== null ? bins[hoverBin] : null;

  return (
    <div className="range-chart" ref={wrapRef}>
      <div className="range-legend">
        <span><i className="rl-line" />ETH price (1 week)</span>
        <span><i className="rl-sw usdc" />USDC</span>
        <span><i className="rl-sw eth" />ETH</span>
        <span className="muted">Drag the gold lines, or the band</span>
      </div>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        onPointerMove={(e) => (drag ? moveDrag(e) : hover(e))}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => !drag && setHoverIdx(null)}
        role="img"
        aria-label={`ETH price over the last week with a liquidity range from ${usd(min, 0)} to ${usd(max, 0)}; current price ${usd(spot, 0)}`}
        className={drag ? "is-dragging" : undefined}
      >
        {/* grid + y axis */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="rc-grid" />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="rc-tick">{usd(t, 0)}</text>
          </g>
        ))}
        {dayTicks.map(({ i, d }) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="rc-tick">
            {d.toLocaleDateString(undefined, { weekday: "short" })}
          </text>
        ))}

        {/* the range band (drag to move the whole range) */}
        <rect
          x={PAD.left}
          width={plotW + 14 + HIST_W}
          y={y(max)}
          height={Math.max(2, y(min) - y(max))}
          className="rc-band"
          onPointerDown={(e) => startDrag("band", e)}
        />

        {/* price */}
        <path d={area} className="rc-area" />
        <path d={line} className="rc-line" />

        {/* liquidity histogram */}
        {bins.map((b, i) => {
          if (b.min === null || b.max === null) return null;
          const top = y(b.max);
          const h = Math.max(3, y(b.min) - top - 2);
          const wAll = (b.usd / maxBinUsd) * HIST_W;
          const usdcW = b.usd > 0 ? (b.usdc / b.usd) * wAll : 0;
          const ethW = Math.max(0, wAll - usdcW - (usdcW > 0 && wAll - usdcW > 0 ? 2 : 0));
          return (
            <g
              key={i}
              onPointerEnter={() => setHoverBin(i)}
              onPointerLeave={() => setHoverBin(null)}
              className={hoverBin === i ? "rc-bin is-hover" : "rc-bin"}
            >
              <rect x={histX} y={top + 1} width={HIST_W} height={h} fill="transparent" />
              {usdcW > 0 && <rect x={histX} y={top + 1} width={usdcW} height={h} rx={3} className="rc-usdc" />}
              {ethW > 0 && <rect x={histX + usdcW + (usdcW > 0 ? 2 : 0)} y={top + 1} width={ethW} height={h} rx={3} className="rc-eth" />}
            </g>
          );
        })}

        {/* current price */}
        <line x1={PAD.left} x2={histX + HIST_W} y1={y(spot)} y2={y(spot)} className="rc-spot" />
        <text x={PAD.left + 6} y={y(spot) - 6} className="rc-spot-label">Now {usd(spot, 0)}</text>

        {/* draggable range lines */}
        {(["max", "min"] as const).map((k) => {
          const p = k === "max" ? max : min;
          const py = y(p);
          return (
            <g
              key={k}
              className="rc-handle"
              tabIndex={0}
              role="slider"
              aria-label={k === "max" ? "Upper price" : "Lower price"}
              aria-valuenow={Math.round(p)}
              aria-valuemin={Math.round(limits.lo)}
              aria-valuemax={Math.round(limits.hi)}
              aria-valuetext={`${usd(p, 0)} (${pct(p, spot)})`}
              onPointerDown={(e) => startDrag(k, e)}
              onKeyDown={(e) => nudge(k, e)}
            >
              <rect x={PAD.left} y={py - 12} width={plotW + 14 + HIST_W} height={24} fill="transparent" style={{ cursor: "ns-resize" }} />
              <line x1={PAD.left} x2={histX + HIST_W} y1={py} y2={py} className="rc-handle-line" />
              <g transform={`translate(${PAD.left + plotW - 132}, ${py - 11})`}>
                <rect width={124} height={22} rx={11} className="rc-chip" />
                <text x={62} y={15} textAnchor="middle" className="rc-chip-text">
                  {usd(p, 0)} · {pct(p, spot)}
                </text>
              </g>
            </g>
          );
        })}

        {/* crosshair */}
        {hc && hoverIdx !== null && (
          <g pointerEvents="none">
            <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD.top} y2={PAD.top + plotH} className="rc-cross" />
            <circle cx={x(hoverIdx)} cy={y(hc.c)} r={4} className="rc-dot" />
          </g>
        )}
      </svg>
      {hc && hoverIdx !== null && (
        <div className="rc-tip" style={{ left: Math.min(W - 150, Math.max(8, x(hoverIdx) + 10)) }}>
          <b>{usd(hc.c)}</b>
          <span>{new Date(hc.t * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}
      {hb && hb.min !== null && hb.max !== null && (
        <div className="rc-tip" style={{ left: histX - 150, top: Math.max(0, y(hb.max) + 20) }}>
          <b>{usd(hb.usd)}</b>
          <span>{usd(hb.min, 0)} – {usd(hb.max, 0)}</span>
          {hb.usdc > 0 && <span><i className="rl-sw usdc" /> {hb.usdc.toFixed(2)} USDC</span>}
          {hb.eth > 0 && <span><i className="rl-sw eth" /> {hb.eth.toFixed(5)} ETH</span>}
        </div>
      )}
    </div>
  );
}
