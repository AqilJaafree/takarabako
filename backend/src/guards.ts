/// Checks that stop the backend moving money when something it relies on looks
/// wrong. A GuardError carries status 503, which the shared error handler
/// turns into the response, so every route reports it the same way.

export class GuardError extends Error {
  status = 503;
}

/// ---- price feeds ---------------------------------------------------------------

/// Opening and closing a position move money at the ETH price. One feed could
/// be wrong or manipulated, so the price is checked against a second one and
/// the move is refused if they differ by more than this.
export const MAX_FEED_DEVIATION = 0.02;

export function feedsAgree(a: number, b: number, max = MAX_FEED_DEVIATION): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) / Math.min(a, b) <= max;
}

/// The last trade price from Kraken's public ticker for ETH/USD.
export function parseKrakenEthUsd(body: unknown): number {
  const last = Number((body as { result?: { XETHZUSD?: { c?: string[] } } })?.result?.XETHZUSD?.c?.[0]);
  if (!(last > 0)) throw new Error("no ETH price in Kraken's answer");
  return last;
}

/// ---- token backing -------------------------------------------------------------

/// Aqua only records virtual balances: the tokens stay in the treasury wallet
/// and are pulled when a swap fills, so the wallet balance is the real limit
/// and a strategy the wallet cannot pay out reverts for the taker.
export interface Amounts {
  eth: bigint;
  usdc: bigint;
}

/// How much of each token the treasury would be short of to pay out every
/// strategy (those open now, plus the ones about to be shipped), counting what
/// it is about to receive (the USD taken out of the customer's vault).
export function backingShortfall(held: Amounts, owed: Amounts, extra: Amounts, incoming: Amounts): Amounts {
  const short = (have: bigint, need: bigint) => (need > have ? need - have : 0n);
  return {
    eth: short(held.eth + incoming.eth, owed.eth + extra.eth),
    usdc: short(held.usdc + incoming.usdc, owed.usdc + extra.usdc),
  };
}
