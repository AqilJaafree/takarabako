import { z } from "zod";
import { ADVANCED, binsFor, type Bin, type HybridOptions } from "./aquaMath.js";

/// The customer's Hybrid choices, as sent to the box and wallet routes.
export const HybridBody = z.object({
  mix: z.enum(["curve", "bidask"]),
  side: z.enum(["both", "base", "quote"]).default("both"),
});

/// The shape of a self-custody position: one of the advanced shapes drawn over a
/// price range the customer can customise, or the whole range ("full", like a
/// classic x*y=k pool).
export type SelfShape = "full" | "spot" | "curve" | "bidask" | "hybrid";
export const SELF_SHAPES: SelfShape[] = ["full", "spot", "curve", "bidask", "hybrid"];

/// The bins for a shape and range at today's price, with the same limits as the
/// advanced picker (from 90% below to 300% above today's price). A full-range
/// position has no range.
export function selfBins(shape: SelfShape, spot: number, min?: number, max?: number, hybrid?: HybridOptions): { bins: Array<Bin | null>; feeBps: number } {
  if (hybrid && shape !== "hybrid") throw new Error("mix and token choices only apply to a Hybrid position");
  if (shape === "full") return { bins: [null], feeBps: ADVANCED.feeBps };
  if (!(typeof min === "number" && typeof max === "number" && min > 0 && max > min)) throw new Error("the range needs a lower price below the upper price");
  const lo = spot * ADVANCED.minFractionOfSpot;
  const hi = spot * ADVANCED.maxMultipleOfSpot;
  if (min < lo) throw new Error(`the lower price can't be more than 90% below today's price ($${lo.toFixed(0)})`);
  if (max > hi) throw new Error(`the upper price can't be above $${hi.toFixed(0)}`);
  return { bins: binsFor(shape, min, max, spot, ADVANCED.bins, hybrid), feeBps: ADVANCED.feeBps };
}

/// A strategy under a cent is not placed (see buildStrategies), so an amount that leaves one out would
/// open only part of the position, or nothing at all. This refuses it and says what is enough.
export function assertFunds(bins: Array<Bin | null>, amount: number) {
  const smallest = Math.min(...bins.map((b) => b?.weight ?? 1));
  if (amount * smallest >= 0.01) return;
  const enough = (Math.ceil((0.01 / smallest) * 100) / 100).toFixed(2);
  throw new Error(bins.length > 1 ? `this amount is too small to split across ${bins.length} strategies: use at least $${enough}` : `the amount must be at least $${enough}`);
}
