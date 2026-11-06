/// How much the treasury lets a contract pull from it. Unlimited approvals
/// put the whole wallet at risk if that contract is ever compromised, so each
/// allowance is sized to what is needed and checked from time to time:
///   - Aqua pulls the token a swap pays out, so its allowance covers what the
///     open strategies could pay out: their balances, which grow as swaps
///     bring the other token in.
///   - The SwapVM router pulls what the treasury pays in when the treasury is
///     itself the taker (only the demo market maker is).
/// An allowance has a margin, so ordinary growth does not need a transaction
/// each time, and an oversized one (such as the old unlimited approval) is
/// brought back down.

/// Raise when the allowance is below this share of the need ...
const RAISE_BELOW = { num: 3n, den: 2n };
/// ... to this multiple of it (the margin) ...
const TARGET = 2n;
/// ... and lower again when it is above this multiple.
const LOWER_ABOVE = 8n;

export type AllowanceAction = { kind: "none" } | { kind: "set"; amount: bigint; why: "raise" | "lower" };

/// What to do about an allowance given what is needed right now.
/// `canLower` is false when the need could not be read in full: lowering on
/// partial data could cut off a swap, so then it only ever raises.
export function allowanceAction(current: bigint, need: bigint, canLower = true): AllowanceAction {
  if (current < (need * RAISE_BELOW.num) / RAISE_BELOW.den) return { kind: "set", amount: need * TARGET, why: "raise" };
  if (canLower && current > need * LOWER_ABOVE) return { kind: "set", amount: need * TARGET, why: "lower" };
  return { kind: "none" };
}
