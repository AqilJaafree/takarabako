import { ADVANCED, binsFor, type Bin } from "./aquaMath.js";

/// The shape of a self-custody position: one of the advanced shapes drawn over a
/// price range the customer can customise, or the whole range ("full", like a
/// classic x*y=k pool).
export type SelfShape = "full" | "spot" | "curve" | "bidask" | "hybrid";
export const SELF_SHAPES: SelfShape[] = ["full", "spot", "curve", "bidask", "hybrid"];

/// The bins for a shape and range at today's price, with the same limits as the
/// advanced picker (from 90% below to 300% above today's price). A full-range
/// position has no range.
export function selfBins(shape: SelfShape, spot: number, min?: number, max?: number): { bins: Array<Bin | null>; feeBps: number } {
  if (shape === "full") return { bins: [null], feeBps: ADVANCED.feeBps };
  if (!(typeof min === "number" && typeof max === "number" && min > 0 && max > min)) throw new Error("the range needs a lower price below the upper price");
  const lo = spot * ADVANCED.minFractionOfSpot;
  const hi = spot * ADVANCED.maxMultipleOfSpot;
  if (min < lo) throw new Error(`the lower price can't be more than 90% below today's price ($${lo.toFixed(0)})`);
  if (max > hi) throw new Error(`the upper price can't be above $${hi.toFixed(0)}`);
  return { bins: binsFor(shape, min, max, spot), feeBps: ADVANCED.feeBps };
}
