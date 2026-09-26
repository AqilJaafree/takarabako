"use client";

import { useEffect, useRef, useState } from "react";
import { usd } from "@/lib/format";

/// Small plain-SVG charts for the ops dashboard. Colors are chart tokens
/// (globals.css .ops): --series-in amber and --series-out blue, validated
/// together against the lacquer surface; text always uses text tokens.

// Rounded 4px data-end, square at the baseline.
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function niceMax(v: number) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const shortDay = (iso: string) => iso.slice(5).replace("-", "/");

export function FlowsChart({ daily }: { daily: Array<{ day: string; cashIn: number; cashOut: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the container's real width, so text stays its true size and the
  // chart keeps a fixed height instead of scaling up on wide screens.
  const plotRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(680);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(480, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 230;
  const pad = { top: 12, right: 8, bottom: 26, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...daily.flatMap((d) => [d.cashIn, d.cashOut])));
  const slot = plotW / Math.max(daily.length, 1);
  const barW = Math.max(3, Math.min(22, slot * 0.3));
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const empty = daily.every((d) => d.cashIn === 0 && d.cashOut === 0);
  const h = hover == null ? null : daily[hover];

  return (
    <figure className="ops-chart">
      <div className="ops-legend">
        <span><i className="sw in" />Cash in</span>
        <span><i className="sw out" />Cash out</span>
      </div>
      <div className="ops-plot" ref={plotRef}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Daily cash in and cash out over the last ${daily.length} days`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">{usd(t, 0)}</text>
            </g>
          ))}
          {daily.map((d, i) => {
            const cx = pad.left + slot * i + slot / 2;
            return (
              <g key={d.day}>
                {hover === i && <rect x={cx - slot / 2} y={pad.top} width={slot} height={plotH} className="hover-band" />}
                <path d={barPath(cx - barW - 1, y(d.cashIn), barW, y(0) - y(d.cashIn))} className="bar in" />
                <path d={barPath(cx + 1, y(d.cashOut), barW, y(0) - y(d.cashOut))} className="bar out" />
                {(i % 2 === daily.length % 2 || daily.length <= 7) && (
                  <text x={cx} y={H - 8} textAnchor="middle" className="tick">{shortDay(d.day)}</text>
                )}
                {/* Hit target: the whole day column, bigger than the bars. */}
                <rect
                  x={cx - slot / 2}
                  y={pad.top}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  aria-label={`${d.day}: cash in ${usd(d.cashIn)}, cash out ${usd(d.cashOut)}`}
                />
              </g>
            );
          })}
        </svg>
        {empty && <p className="ops-empty">No cash has moved through the kiosk in the last {daily.length} days.</p>}
        {h && hover != null && (
          <div className="ops-tip" style={{ left: `${((pad.left + slot * hover + slot / 2) / W) * 100}%` }}>
            <b>{h.day}</b>
            <span><i className="sw in" />Cash in <b>{usd(h.cashIn)}</b></span>
            <span><i className="sw out" />Cash out <b>{usd(h.cashOut)}</b></span>
          </div>
        )}
      </div>
      <details className="ops-table-toggle">
        <summary>Table view</summary>
        <table className="ops-table">
          <thead><tr><th>Day</th><th>Cash in</th><th>Cash out</th></tr></thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.day}><td>{d.day}</td><td>{usd(d.cashIn)}</td><td>{usd(d.cashOut)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/// Single-series horizontal bars: magnitude by category, one hue, the value
/// labelled at each bar's end in text ink.
export function HBars({
  rows,
  emptyText,
  valueLabel,
}: {
  rows: Array<{ key: string; label: string; value: number; hint?: string }>;
  emptyText: string;
  valueLabel: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (!rows.length) return <p className="ops-empty">{emptyText}</p>;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <figure className="ops-chart">
      <ul className="ops-hbars">
        {rows.map((r) => (
          <li
            key={r.key}
            onMouseEnter={() => setHover(r.key)}
            onMouseLeave={() => setHover(null)}
            className={hover === r.key ? "is-hover" : undefined}
          >
            <span className="hb-label" title={r.hint ?? r.label}>{r.label}</span>
            <span className="hb-track">
              <span className="hb-bar" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
            </span>
            <span className="hb-value">{usd(r.value)}</span>
            {hover === r.key && (
              <span className="ops-tip inline">
                <b>{r.hint ?? r.label}</b>
                <span>{valueLabel} <b>{usd(r.value)}</b></span>
                <span>Share <b>{total ? ((r.value / total) * 100).toFixed(1) : "0"}%</b></span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <details className="ops-table-toggle">
        <summary>Table view</summary>
        <table className="ops-table">
          <thead><tr><th>Name</th><th>{valueLabel}</th><th>Share</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.hint ?? r.label}</td>
                <td>{usd(r.value)}</td>
                <td>{total ? ((r.value / total) * 100).toFixed(1) : "0"}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
