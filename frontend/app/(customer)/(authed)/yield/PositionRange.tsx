import { usd } from "@/lib/format";

/// Where today's price sits in (or around) a position's range, on a log scale.
export function PositionRange({ min, max, spot, base = "ETH", digits = 0 }: { min: number; max: number; spot: number; base?: string; digits?: number }) {
  const lo = Math.min(min, spot) / 1.05;
  const hi = Math.max(max, spot) * 1.05;
  const at = (v: number) => ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100;
  return (
    <div className="pos-range" aria-label={`Range ${usd(min, digits)} to ${usd(max, digits)}, ${base} now ${usd(spot, digits)}`}>
      <span className="pos-range-band" style={{ left: `${at(min)}%`, width: `${at(max) - at(min)}%` }} />
      <span className="pos-range-now" style={{ left: `${at(spot)}%` }} />
    </div>
  );
}
