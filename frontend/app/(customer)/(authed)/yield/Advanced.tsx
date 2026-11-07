"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HybridOptions, LiquidityRequest, Market, Preview, PreviewBin, Shape } from "@/lib/types";
import { apy, usd } from "@/lib/format";
import { LiquidityPanel } from "./LiquidityPanel";
import { RangeChart } from "./RangeChart";

export type OpenRequest = {
  amount: number;
  shape: Shape;
  /// Absent for a full-range position, which has no range.
  priceMin?: number;
  priceMax?: number;
  hybrid?: HybridOptions;
  /// What to call it on screen, such as "Hybrid (Spot + Curve) · USDC only".
  label: string;
};

const SHAPES: Array<{ id: Shape; name: string; hint: string }> = [
  { id: "spot", name: "Spot", hint: "Even" },
  { id: "curve", name: "Curve", hint: "Most near price" },
  { id: "bidask", name: "Bid-Ask", hint: "Most at the edges" },
  { id: "hybrid", name: "Hybrid", hint: "Spot + Curve or Bid-Ask" },
  { id: "full", name: "Full range", hint: "Every price" },
];

const signedPct = (price: number, spot: number) => {
  const v = (price / spot - 1) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
};

/// The range a Hybrid starts from for each token choice: one-sided ranges sit just off the price.
function startRange(side: HybridOptions["side"], spot: number, stable: boolean) {
  const w = stable ? 0.015 : 0.2;
  const gap = stable ? 0.001 : 0.01;
  if (side === "quote") return { min: spot * (1 - w), max: spot * (1 - gap) };
  if (side === "base") return { min: spot * (1 + gap), max: spot * (1 + w) };
  return { min: spot * (1 - w), max: spot * (1 + w) };
}

export function Advanced({
  market,
  balance,
  onOpen,
  preview: requestPreview,
  confirm,
  initialAmount,
  availableLabel,
  allowFull = false,
  stable = false,
  symbols = { base: "ETH", quote: "USDC" },
  priceDigits = 0,
  showEstimates = true,
  disabled = false,
  readOnly,
}: {
  market: Market;
  /// The most that can go in.
  balance: number;
  onOpen: (req: OpenRequest) => Promise<void>;
  /// How the liquidity would split. Must be a stable function: a new one fetches again.
  preview: (req: LiquidityRequest) => Promise<Preview>;
  /// Asked before anything is placed (on a real-money network); false cancels.
  confirm?: (summary: string) => Promise<boolean>;
  initialAmount?: number;
  availableLabel?: string;
  /// Offer the whole range as a shape (positions signed by a wallet).
  allowFull?: boolean;
  /// A pair that trades near one price, so its ranges are narrow.
  stable?: boolean;
  symbols?: { base: string; quote: string };
  priceDigits?: number;
  showEstimates?: boolean;
  /// Something else is in progress.
  disabled?: boolean;
  /// A preview on a network positions can't be opened on: this button replaces opening one.
  readOnly?: { label: string; onClick: () => void };
}) {
  const spot = market.spot;
  const limits = useMemo(() => ({ lo: market.advanced.minPrice, hi: market.advanced.maxPrice }), [market.advanced.minPrice, market.advanced.maxPrice]);
  const [shape, setShape] = useState<Shape>("curve");
  const [mix, setMix] = useState<HybridOptions["mix"]>("curve");
  const [tokens, setTokens] = useState<HybridOptions["side"]>("both");
  const [range, setRange] = useState(() => startRange("both", spot, stable));
  const [wanted, setAmount] = useState(initialAmount ?? Math.floor(balance * 100) / 100);
  const amount = Math.min(wanted, balance); // the box can shrink while this is open
  const [previewed, setPreviewed] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState(false);

  const full = shape === "full";
  const isHybrid = shape === "hybrid";
  const side = isHybrid ? tokens : "both"; // token choices are a Hybrid's
  const hybrid = useMemo<HybridOptions | undefined>(() => (isHybrid ? { mix, side: tokens } : undefined), [isHybrid, mix, tokens]);

  // A one-sided range stays on its side of the price, and at least 2% wide (as the chart keeps it).
  const edge = stable ? 0.001 : 0.005;
  const fit = (min: number, max: number) => {
    if (side === "quote") {
      const hi = Math.min(max, spot * (1 - edge));
      return { min: Math.max(limits.lo, Math.min(min, hi / 1.02)), max: hi };
    }
    if (side === "base") {
      const lo = Math.max(min, spot * (1 + edge));
      return { min: lo, max: Math.min(limits.hi, Math.max(max, lo * 1.02)) };
    }
    return { min, max };
  };
  const change = (min: number, max: number) => setRange(fit(min, max));

  function chooseTokens(next: HybridOptions["side"]) {
    setTokens(next);
    setRange(startRange(next, spot, stable));
  }
  function chooseShape(next: Shape) {
    if (next === "hybrid" && tokens !== "both") setRange(startRange(tokens, spot, stable));
    setShape(next);
  }

  const presets: Array<{ name: string; min: number; max: number }> = stable
    ? [
        { name: "±0.5%", min: spot * 0.995, max: spot * 1.005 },
        { name: "±1.5%", min: spot * 0.985, max: spot * 1.015 },
        { name: "±5%", min: spot * 0.95, max: spot * 1.05 },
      ]
    : [
        { name: "±15%", min: spot * 0.85, max: spot * 1.15 },
        { name: "±50%", min: spot * 0.5, max: spot * 1.5 },
        { name: "Buy the dip", min: limits.lo, max: spot * 0.97 },
        { name: "Sell the rally", min: spot * 1.03, max: spot * 2 },
      ];

  // Preview the split (debounced while dragging). A full-range position is one block, worked out here.
  const seq = useRef(0);
  useEffect(() => {
    if (full) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const p = await requestPreview({ amount: amount > 0 ? amount : 100, shape, priceMin: range.min, priceMax: range.max, ...(hybrid ? { hybrid } : {}) });
        if (id === seq.current) {
          setPreviewed(p);
          setPreviewError("");
        }
      } catch (e) {
        if (id === seq.current) setPreviewError(e instanceof Error ? e.message : "preview failed");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [full, shape, hybrid, range.min, range.max, amount, requestPreview]);

  const fullBins = useMemo<PreviewBin[]>(() => [{ min: limits.lo, max: limits.hi, weight: 1, usd: amount, eth: amount / 2 / spot, usdc: amount / 2 }], [limits.lo, limits.hi, amount, spot]);
  const bins = full ? fullBins : (previewed?.bins ?? []);
  const shownSide = full ? "both" : (previewed?.side ?? "both");
  const totals = bins.reduce((s, b) => ({ eth: s.eth + b.eth, usdc: s.usdc + b.usdc }), { eth: 0, usdc: 0 });
  const failed = !full && Boolean(previewError);

  const shapeName = SHAPES.find((s) => s.id === shape)?.name ?? shape;
  const held = side === "base" ? symbols.base : side === "quote" ? symbols.quote : null;
  const label = isHybrid ? `Hybrid (Spot + ${mix === "curve" ? "Curve" : "Bid-Ask"})${held ? ` · ${held} only` : ""}` : shapeName;
  const rangeText = full ? "every price" : `${usd(range.min, priceDigits)} – ${usd(range.max, priceDigits)}`;

  return (
    <section className="card">
      <h2>Draw your range</h2>
      <p className="muted small">Earns only while {symbols.base} trades inside your range.</p>

      <div className="shape-picker" role="radiogroup" aria-label="Liquidity shape">
        {SHAPES.filter((s) => allowFull || s.id !== "full").map((s) => (
          <button key={s.id} role="radio" aria-checked={shape === s.id} className={shape === s.id ? "is-on" : ""} onClick={() => chooseShape(s.id)}>
            <ShapeIcon shape={s.id} />
            <b>{s.name}</b>
            <span className="muted small">{s.hint}</span>
          </button>
        ))}
      </div>

      {isHybrid && (
        <div className="hybrid-options">
          <div className="self-shape">
            <span className="label">Combine Spot with</span>
            <div className="row" role="radiogroup" aria-label="Combine Spot with">
              {(["curve", "bidask"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mix === m} className={`chip btn btn-ghost small${mix === m ? " is-on" : ""}`} onClick={() => setMix(m)}>
                  {m === "curve" ? "Curve" : "Bid-Ask"}
                </button>
              ))}
            </div>
          </div>
          <div className="self-shape">
            <span className="label">Tokens</span>
            <div className="row" role="radiogroup" aria-label="Tokens">
              {([["both", "Two-sided"], ["base", `${symbols.base} only`], ["quote", `${symbols.quote} only`]] as const).map(([id, name]) => (
                <button key={id} type="button" role="radio" aria-checked={tokens === id} className={`chip btn btn-ghost small${tokens === id ? " is-on" : ""}`} onClick={() => chooseTokens(id)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          {held && (
            <p className="notice warn small" style={{ margin: 0 }}>
              Holds only {held}. It earns nothing until {symbols.base} {side === "base" ? "rises" : "falls"} into this range.
            </p>
          )}
        </div>
      )}

      <LiquidityPanel title="Range and liquidity">
        <RangeChart
          candles={market.candles}
          spot={spot}
          min={full ? limits.lo : range.min}
          max={full ? limits.hi : range.max}
          limits={limits}
          bins={bins}
          onChange={change}
          locked={full}
          symbols={symbols}
          priceDigits={priceDigits}
        />
      </LiquidityPanel>

      {!full && (
        <>
          <div className="row presets">
            {presets.map((p) => (
              <button key={p.name} type="button" className="btn btn-ghost small chip" onClick={() => change(p.min, p.max)}>
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
                step={priceDigits > 0 ? 10 ** -priceDigits : 1}
                value={Number(range.min.toFixed(priceDigits))}
                min={Math.ceil(limits.lo)}
                onChange={(e) => change(Math.max(limits.lo, Number(e.target.value) || range.min), range.max)}
              />
              <span className="muted small">{signedPct(range.min, spot)}</span>
            </label>
            <label>
              <span className="label">Upper price</span>
              <input
                className="input"
                type="number"
                step={priceDigits > 0 ? 10 ** -priceDigits : 1}
                value={Number(range.max.toFixed(priceDigits))}
                max={Math.floor(limits.hi)}
                onChange={(e) => change(range.min, Math.min(limits.hi, Number(e.target.value) || range.max))}
              />
              <span className="muted small">{signedPct(range.max, spot)}</span>
            </label>
          </div>
        </>
      )}

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
        <p className="muted small" style={{ margin: "4px 0 0" }}>{availableLabel ?? `${usd(balance)} available`}</p>
      </div>

      <div className="preview-box">
        {failed ? (
          <span className="tone-bad small">{previewError}</span>
        ) : bins.length > 0 ? (
          <>
            <span className={`pill ${shownSide === "both" ? "ok" : "warn"}`}>
              {shownSide === "usdc" ? `One-sided · ${symbols.quote} (bid)` : shownSide === "eth" ? `One-sided · ${symbols.base} (ask)` : "Two-sided · in range now"}
            </span>
            <span className="small">
              {bins.length} strateg{bins.length === 1 ? "y" : "ies"} · {totals.usdc.toFixed(2)} {symbols.quote} + {totals.eth.toFixed(5)} {symbols.base}
              {amount > 0 ? "" : " (preview for $100)"}
            </span>
            <span className="muted small">
              {showEstimates ? `~${apy(market.advanced.apyEstBps)} APY estimate · ` : ""}
              {(market.advanced.feeBps / 100).toFixed(2)}% fee
            </span>
          </>
        ) : (
          <span className="muted small">Working out the split…</span>
        )}
      </div>

      {readOnly ? (
        <button type="button" className="btn btn-gold btn-block" onClick={readOnly.onClick}>
          {readOnly.label}
        </button>
      ) : (
      <button
        className="btn btn-gold btn-block"
        disabled={busy || disabled || !(amount > 0) || amount > balance || failed || bins.length === 0}
        onClick={async () => {
          if (confirm && !(await confirm(`${usd(amount)} into an Advanced ${label} strategy, ${rangeText}`))) return;
          setBusy(true);
          await onOpen({ amount, shape, ...(full ? {} : { priceMin: range.min, priceMax: range.max }), ...(hybrid ? { hybrid } : {}), label });
          setBusy(false);
        }}
      >
        {busy ? "Shipping strategies to 1inch Aqua…" : `Open ${usd(amount)} · ${full ? "Full range" : rangeText}`}
      </button>
      )}
    </section>
  );
}

function ShapeIcon({ shape }: { shape: Shape }) {
  const bars =
    shape === "spot" || shape === "full" ? [3, 3, 3, 3, 3] : shape === "curve" ? [1, 2, 4, 2, 1] : shape === "hybrid" ? [2, 2, 4, 2, 2] : [4, 2, 1, 2, 4];
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true" className="shape-icon">
      {bars.map((h, i) => (
        <rect key={i} x={2 + i * 8.4} y={22 - h * 5} width="6" height={h * 5} rx="2" className={i < 2 ? "usdc" : i > 2 ? "eth" : "mid"} />
      ))}
    </svg>
  );
}
