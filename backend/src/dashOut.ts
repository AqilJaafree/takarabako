import { decodeFunctionResult, formatUnits, parseAbi, type Address, type Hex } from "viem";
import { config } from "./config.js";
import { pool } from "./db.js";
import { sv } from "./aquaSdk.js";
import { GuardError } from "./guards.js";
import { retryOnLag } from "./retry.js";
import { selfClient, type SelfNet } from "./selfChain.js";
import type { Step } from "./selfCustody.js";
import { encodeFunctionData } from "viem";

/// Dash out: sell the base token a customer is left holding (WETH or EURC on Arc, mETH on Sepolia), for
/// example after closing a position that traded into it, for USDC (the quote token every pair exits to),
/// through 1inch Aqua's own taker side. It works for any pair: it trades only against strategies in the
/// same pair and compares the price with that pair's own market price.
///
/// The SwapVM router does not route: a swap names the one strategy to trade against. So this finds the
/// strategies other positions have open on the chain, asks the router what each would pay (quote is a
/// read-only simulation), fills the best-priced first, and builds the customer's own transactions: an
/// approval for exactly the amount being sold, then one swap per strategy, each with a minimum payout.
/// It refuses when the price is far worse than the market, since a strategy's range can sit well away
/// from it. Nothing here sends anything: the customer's wallet signs.

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 hash, address token) view returns (uint248, uint8)"]);

/// A strategy that could buy the base token for USDC.
export interface Candidate {
  order: string;
  hash: string;
  maker: string;
  /// The wallet that owns the position it belongs to, if known (never trade against your own).
  owner: string | null;
  /// USDC the strategy holds (raw, 6 decimals): the most it can pay out.
  usdc: bigint;
}

export interface Fill {
  candidate: Candidate;
  amountIn: bigint;
  amountOut: bigint;
}

/// What a swap of `amount` base token would pay against `candidate`, or null if it cannot (it would
/// pay out more than the strategy holds, or the strategy does not take this token).
export type Quoter = (candidate: Candidate, amount: bigint) => Promise<bigint | null>;

/// The most of `hi` the strategy can take: `hi` if it all fits, else the largest size it still quotes
/// for (found by halving). Quotes are monotonic in size, so the search is sound.
export async function maxFill(quote: Quoter, c: Candidate, hi: bigint, steps = 14): Promise<bigint> {
  if (hi <= 0n) return 0n;
  if ((await quote(c, hi)) !== null) return hi;
  let lo = 0n;
  let top = hi;
  for (let i = 0; i < steps && top - lo > 1n; i++) {
    const mid = (lo + top) / 2n;
    if ((await quote(c, mid)) !== null) lo = mid;
    else top = mid;
  }
  return lo;
}

/// Splits `amount` across the candidates, best price first. Each strategy is a separate pool, so a
/// fill against one does not move another. A small probe ranks them by price; each is then filled up to
/// what it can take, and the final size of each fill is re-quoted for the exact payout.
export async function planFills(quote: Quoter, candidates: Candidate[], amount: bigint): Promise<{ fills: Fill[]; filled: bigint; out: bigint }> {
  const probe = amount / 50n > 0n ? amount / 50n : amount;
  const ranked: Array<{ c: Candidate; rate: number; cap: bigint }> = [];
  for (const c of candidates) {
    const cap = await maxFill(quote, c, amount);
    if (cap <= 0n) continue;
    const p = cap < probe ? cap : probe;
    const out = await quote(c, p);
    if (out === null || out <= 0n) continue;
    ranked.push({ c, rate: Number(out) / Number(p), cap });
  }
  ranked.sort((a, b) => b.rate - a.rate);

  const fills: Fill[] = [];
  let left = amount;
  for (const r of ranked) {
    if (left <= 0n) break;
    const take = r.cap < left ? r.cap : left;
    const out = await quote(r.c, take);
    if (out === null || out <= 0n) continue;
    fills.push({ candidate: r.c, amountIn: take, amountOut: out });
    left -= take;
  }
  return { fills, filled: amount - left, out: fills.reduce((s, f) => s + f.amountOut, 0n) };
}

/// The strategies open in this pair on this chain that hold USDC, from the database: customers'
/// self-custody positions, and (for the chain's default pair, on the chain this backend runs on) the
/// treasury's.
async function loadCandidates(net: SelfNet, taker: string): Promise<Candidate[]> {
  const rows: Array<{ owner: string | null; strategies: Array<{ order: string; hash: string }> }> = [];
  const self = await pool.query("select wallet as owner, strategies from self_positions where chain_id = $1 and coalesce(pair, $2) = $3 and status = 'open'", [net.chainId, net.pairKeys[0], net.pairKey]);
  rows.push(...self.rows);
  if (net.chainId === config.network.chain.id && net.pairKey === net.pairKeys[0]) {
    const treasury = await pool.query("select null::text as owner, strategies from aqua_positions where status = 'open'");
    rows.push(...treasury.rows);
  }
  const c = selfClient(net);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // never trade against a position you own: you would pay your own fee for nothing
    if (r.owner && r.owner.toLowerCase() === taker.toLowerCase()) continue;
    for (const s of r.strategies) {
      if (seen.has(s.hash.toLowerCase())) continue;
      seen.add(s.hash.toLowerCase());
      let maker: string;
      try {
        maker = sv.Order.decode(new sv.HexString(s.order)).maker.toString();
      } catch {
        continue;
      }
      try {
        const [bal] = await retryOnLag(() =>
          c.readContract({ address: net.aqua!, abi: aquaAbi, functionName: "rawBalances", args: [maker as Address, net.router!, s.hash as Hex, net.pair.usdc.address as Address] }),
        );
        if (bal >= 10_000n) out.push({ order: s.order, hash: s.hash, maker, owner: r.owner, usdc: BigInt(bal) }); // at least 0.01 USDC
      } catch {
        /* a strategy that cannot be read is skipped */
      }
    }
  }
  return out;
}

/// The router's quote for selling `amount` base token against one strategy, from `taker`.
function routerQuoter(net: SelfNet, taker: Address): Quoter {
  const call = new sv.SwapVMContract(new sv.Address(net.router!));
  const c = selfClient(net);
  return async (cand, amount) => {
    const q = call.quote({
      order: sv.Order.decode(new sv.HexString(cand.order)),
      amount,
      takerTraits: sv.TakerTraits.default(),
      tokenIn: new sv.Address(net.pair.eth.address),
      tokenOut: new sv.Address(net.pair.usdc.address),
    });
    try {
      const res = await c.call({ account: taker, to: q.to.toString() as Address, data: q.data.toString() as Hex });
      const [, amountOut] = decodeFunctionResult({ abi: sv.ABI.SWAP_VM_ABI, functionName: "quote", data: res.data! }) as readonly bigint[];
      return amountOut ?? null;
    } catch {
      return null;
    }
  };
}

const unit = (decimals: bigint) => 10n ** decimals;

export interface DashOutQuote {
  /// What the wallet holds of the base token, and how much of it is being sold.
  balance: bigint;
  amountIn: bigint;
  amountOut: bigint;
  /// Base token that no strategy could take.
  unfilled: bigint;
  /// USDC per base token that the fills pay, and the market's, and how far below it the fills are (%).
  rate: number | null;
  marketRate: number | null;
  discountPct: number | null;
  /// Whether the discount is within what this app allows. A refused quote cannot be prepared.
  allowed: boolean;
  reason: string | null;
  fills: Fill[];
}

/// What dashing out `amount` (default: all of it) of the wallet's base token would get right now.
export async function dashOutQuote(net: SelfNet, wallet: string, amount?: bigint): Promise<DashOutQuote> {
  if (!net.aqua || !net.router) throw new GuardError(`1inch Aqua is not available on ${net.name}`);
  const c = selfClient(net);
  const balance = await c.readContract({ address: net.pair.eth.address as Address, abi: erc20, functionName: "balanceOf", args: [wallet as Address] });
  const want = amount === undefined || amount > balance ? balance : amount;
  const empty = (reason: string): DashOutQuote => ({ balance, amountIn: 0n, amountOut: 0n, unfilled: want, rate: null, marketRate: null, discountPct: null, allowed: false, reason, fills: [] });
  if (want <= 0n) return empty(`your wallet holds no ${net.symbols.base} to dash out`);

  const candidates = await loadCandidates(net, wallet);
  if (candidates.length === 0) return empty(`no open strategy on ${net.name} can buy ${net.symbols.base} for ${net.symbols.quote} right now`);
  const { fills, filled, out } = await planFills(routerQuoter(net, wallet as Address), candidates, want);
  if (fills.length === 0) return empty(`no open strategy on ${net.name} will take ${net.symbols.base} at this size`);

  const market = await net.spot().catch(() => null);
  const rate = (Number(out) / Number(unit(net.pair.usdc.decimals))) / (Number(filled) / Number(unit(net.pair.eth.decimals)));
  const discountPct = market ? ((market - rate) / market) * 100 : null;
  let allowed = true;
  let reason: string | null = null;
  if (market === null) {
    allowed = false;
    reason = "the market price could not be checked right now, so the swap is not offered";
  } else if (discountPct! > config.dashOut.maxDiscountPct) {
    allowed = false;
    reason = `the best strategies pay ${discountPct!.toFixed(1)}% below the market price, more than the ${config.dashOut.maxDiscountPct}% this app allows`;
  }
  return { balance, amountIn: filled, amountOut: out, unfilled: want - filled, rate, marketRate: market, discountPct, allowed, reason, fills };
}

/// The transactions to dash out: an approval for the router for exactly what is sold (if short), then
/// one swap per strategy with a minimum payout (the quote less the slippage allowance).
export async function prepareDashOut(net: SelfNet, wallet: string, amount?: bigint): Promise<{ steps: Step[]; quote: DashOutQuote; minOut: bigint }> {
  const quote = await dashOutQuote(net, wallet, amount);
  if (quote.fills.length === 0) throw Object.assign(new Error(quote.reason ?? "nothing to dash out"), { status: 422 });
  if (!quote.allowed) throw Object.assign(new Error(quote.reason ?? "this swap is not allowed"), { status: 422 });

  const c = selfClient(net);
  const router = net.router!;
  const call = new sv.SwapVMContract(new sv.Address(router));
  const steps: Step[] = [];
  const allowance = await c.readContract({ address: net.pair.eth.address as Address, abi: erc20, functionName: "allowance", args: [wallet as Address, router] });
  if (allowance < quote.amountIn) {
    steps.push({
      to: net.pair.eth.address as Address,
      data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [router, quote.amountIn] }),
      description: `Let the 1inch Aqua router take ${formatUnits(quote.amountIn, Number(net.pair.eth.decimals))} ${net.symbols.base} from your wallet, for this swap only.`,
    });
  }
  let minOut = 0n;
  for (const [i, f] of quote.fills.entries()) {
    const floor = (f.amountOut * BigInt(10_000 - config.dashOut.slippageBps)) / 10_000n;
    minOut += floor;
    const s = call.swap({
      order: sv.Order.decode(new sv.HexString(f.candidate.order)),
      amount: f.amountIn,
      takerTraits: sv.TakerTraits.default().with({ threshold: floor }),
      tokenIn: new sv.Address(net.pair.eth.address),
      tokenOut: new sv.Address(net.pair.usdc.address),
    });
    steps.push({
      to: s.to.toString() as Address,
      data: s.data.toString() as Hex,
      description: `Sell ${formatUnits(f.amountIn, Number(net.pair.eth.decimals))} ${net.symbols.base} for at least ${formatUnits(floor, Number(net.pair.usdc.decimals))} ${net.symbols.quote}${quote.fills.length > 1 ? ` (${i + 1} of ${quote.fills.length})` : ""}`,
    });
  }
  return { steps, quote, minOut };
}
