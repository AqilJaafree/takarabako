/// The treasury ops agent's hard limits, enforced in code rather than in its
/// prompt: a proposal that breaks one is rejected with a reason and never
/// reaches the approval queue. Checked again at approval time, since the
/// day's totals may have moved in between.

export type ProposalAction = "fund_yield_reserve" | "set_apy" | "pause_kiosk" | "mint_usdc_float";

export const POLICY = {
  maxApyBps: 2000, // 20% — the vault's mock APY never goes above this
  minApyBps: 0,
  maxYieldReserveFundingPerDay: 500, // USDC topped up into the vault per UTC day
  maxFloatMintPerDay: 10_000, // mUSDC the treasury mints for itself per UTC day
} as const;

/// What has already been executed today, per action.
export interface PolicyContext {
  fundedToday: number;
  mintedToday: number;
  knownKiosks: string[];
}

export type PolicyResult = { ok: true } | { ok: false; reason: string };

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function checkPolicy(action: ProposalAction, args: Record<string, unknown>, ctx: PolicyContext): PolicyResult {
  switch (action) {
    case "set_apy": {
      const bps = args.bps;
      if (typeof bps !== "number" || !Number.isInteger(bps)) return { ok: false, reason: "bps must be a whole number" };
      if (bps < POLICY.minApyBps || bps > POLICY.maxApyBps)
        return { ok: false, reason: `APY must stay between ${POLICY.minApyBps} and ${POLICY.maxApyBps} bps (asked ${bps})` };
      return { ok: true };
    }
    case "fund_yield_reserve": {
      if (!positive(args.amount)) return { ok: false, reason: "amount must be a positive number of USDC" };
      const after = ctx.fundedToday + args.amount;
      if (after > POLICY.maxYieldReserveFundingPerDay)
        return {
          ok: false,
          reason: `yield-reserve funding is capped at ${POLICY.maxYieldReserveFundingPerDay} USDC a day; ${ctx.fundedToday} already funded today, so at most ${Math.max(0, POLICY.maxYieldReserveFundingPerDay - ctx.fundedToday)} more`,
        };
      return { ok: true };
    }
    case "mint_usdc_float": {
      if (!positive(args.amount)) return { ok: false, reason: "amount must be a positive number of USDC" };
      const after = ctx.mintedToday + args.amount;
      if (after > POLICY.maxFloatMintPerDay)
        return {
          ok: false,
          reason: `float minting is capped at ${POLICY.maxFloatMintPerDay} USDC a day; ${ctx.mintedToday} already minted today`,
        };
      return { ok: true };
    }
    case "pause_kiosk": {
      // Pausing is always allowed — it only stops new cash coming in.
      // Unpausing isn't an action the agent has at all: a human does it.
      const kioskId = args.kioskId;
      if (typeof kioskId !== "string" || !kioskId) return { ok: false, reason: "kioskId is required" };
      if (!ctx.knownKiosks.includes(kioskId)) return { ok: false, reason: `unknown kiosk ${kioskId}` };
      if (typeof args.reason !== "string" || !args.reason.trim()) return { ok: false, reason: "a reason is required" };
      return { ok: true };
    }
    default:
      return { ok: false, reason: `unknown action ${String(action)}` };
  }
}
