import type { RiskTier } from "@/lib/types";

/// A banknote in flight: dropped on deposit.pending, melts to gold on
/// deposit.confirmed, greys out on deposit.failed.
export interface StageNote {
  id: string;
  amount: number;
  currency: string;
  status: "pending" | "confirmed" | "failed";
}

export type CatMood = "idle" | "happy" | "thinking" | "worried";

export interface StageGem {
  id: string;
  riskTier: RiskTier;
  apyBps: number;
}

export interface StageProps {
  balance: number;
  notes: StageNote[];
  gems: StageGem[];
  mood: CatMood;
  line: string;
  /** Bumps to make the cat hop. */
  hop: number;
  /** Bumps to stream coins out of the box (withdraw). */
  burst: number;
  /** Tx hash briefly etched on the lid after a confirmed deposit. */
  etch: string | null;
  onNoteDone: (id: string) => void;
  height?: number;
}
