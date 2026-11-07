import { encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address } from "viem";
import { config } from "./config.js";
import { looksLikeRpcLag, retryOnLag } from "./retry.js";
import { allowanceAction } from "./allowances.js";
import { backingShortfall, feedsAgree, GuardError, parseKrakenEthUsd, type Amounts } from "./guards.js";
import { floorMicros, PAYOUT_PENDING, payoutStep } from "./closeFlow.js";
import { pool } from "./db.js";
import { aq, sv } from "./aquaSdk.js";
import {
  ADVANCED,
  TIERS,
  allocate,
  binsFor,
  sqrtBounds,
  valueUsd,
  type Bin,
  type PairTokens,
  type Shape,
  type HybridOptions,
  type Tier,
} from "./aquaMath.js";
import { assertFunds } from "./selfShapes.js";
import {
  chainReady,
  depositOnChain,
  publicClient,
  sendDepositTx,
  sendTreasuryTx,
  sendTreasuryTxNoWait,
  treasuryAddress,
  waitForDepositTx,
  waitForTx,
  withdrawUsdOnChain,
} from "./chain.js";

/// 1inch Aqua yield. The treasury is the Aqua maker: a position takes USD
/// out of the customer's vault, and the treasury ships SwapVM strategies
/// (mETH/mUSDC) for it through Aqua — virtual balances over tokens that stay
/// in the treasury wallet. Closing docks them and returns their value, at
/// the live ETH price, to the customer's vault.

export const PAIR: PairTokens = {
  eth: { address: config.aqua.methAddress, decimals: 18n },
  usdc: { address: config.usdcAddress, decimals: 6n },
};

export const aquaReady = chainReady && config.aqua.deployed && Boolean(config.aqua.methAddress && config.usdcAddress);

/// Why yield positions can't open on this network (null = they can).
export function aquaUnavailableReason(): string | null {
  if (!chainReady) return "chain not configured — cannot open an Aqua position";
  if (!config.aqua.deployed)
    return `1inch Aqua is not available on ${config.network.name} — set AQUA_ADDRESS and AQUA_ROUTER_ADDRESS if you deployed it there`;
  if (!config.aqua.methAddress || !config.usdcAddress) return "set METH_ADDRESS and USDC_ADDRESS for the Aqua pair";
  return null;
}

/// Reads the chain to confirm the Aqua registry, the SwapVM router and both
/// pair tokens have code at the configured addresses.
export async function verifyAquaOnChain(): Promise<{ ok: boolean; missing: string[] }> {
  const checks: Array<[string, string]> = [
    ["Aqua registry", config.aqua.address],
    ["SwapVM router", config.aqua.router],
    ["base token", config.aqua.methAddress],
    ["USDC", config.usdcAddress],
  ];
  const missing: string[] = [];
  for (const [name, address] of checks) {
    const code = address ? await publicClient.getCode({ address: address as Address }).catch(() => undefined) : undefined;
    if (!code || code === "0x") missing.push(`${name} (${address || "unset"})`);
  }
  return { ok: missing.length === 0, missing };
}

const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)"]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

// ---- ETH price (Coinbase public API) --------------------------------------

let spotCache: { at: number; price: number } | null = null;
let candleCache: { at: number; candles: Candle[] } | null = null;

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
}

/// Live ETH/USD from Coinbase, cached 30s. mETH is priced off real ETH. If the
/// feed fails, the last price is used (stale beats nothing for a display),
/// unless the caller sets `maxStaleMs`. With `verify`, the price is also
/// checked against a second feed (Kraken) and refused if they disagree: opening
/// and closing a position move money at this price, so they set both.
export async function ethUsd(opts: { maxStaleMs?: number; verify?: boolean } = {}): Promise<number> {
  const price = await coinbasePrice(opts);
  if (opts.verify) await checkAgainstSecondFeed(price);
  return price;
}

async function coinbasePrice(opts: { maxStaleMs?: number }): Promise<number> {
  if (spotCache && Date.now() - spotCache.at < 30_000) return spotCache.price;
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(5000) });
    const price = Number((await res.json()).data.amount);
    if (!(price > 0)) throw new Error("bad price");
    spotCache = { at: Date.now(), price };
    return price;
  } catch (err) {
    if (spotCache && (opts.maxStaleMs === undefined || Date.now() - spotCache.at <= opts.maxStaleMs)) return spotCache.price;
    const why = err instanceof Error ? err.message : err;
    throw new Error(spotCache ? `ETH price is too old to move money at (feed down: ${why})` : `ETH price unavailable: ${why}`);
  }
}

let secondCache: { at: number; price: number } | null = null;
let secondWarnedAt = 0;

async function krakenPrice(): Promise<number | null> {
  if (secondCache && Date.now() - secondCache.at < 30_000) return secondCache.price;
  try {
    const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD", { signal: AbortSignal.timeout(5000) });
    const price = parseKrakenEthUsd(await res.json());
    secondCache = { at: Date.now(), price };
    return price;
  } catch {
    return null;
  }
}

/// Refuses to go on if the second feed disagrees with the first. If the second
/// feed is simply unreachable the check cannot be made, so it carries on with
/// the first alone (and says so, at most every ten minutes) rather than
/// stopping every customer's withdrawal over a monitoring outage.
async function checkAgainstSecondFeed(price: number) {
  const other = await krakenPrice();
  if (other === null) {
    if (Date.now() - secondWarnedAt > 10 * 60_000) {
      secondWarnedAt = Date.now();
      console.warn("[price] the second price feed (Kraken) is unreachable: moving money at Coinbase's price alone");
    }
    return;
  }
  if (!feedsAgree(price, other)) {
    throw new GuardError(`the ETH price feeds disagree (Coinbase $${price.toFixed(2)}, Kraken $${other.toFixed(2)}): not moving money until they agree`);
  }
}

/// For tests: forget the cached prices.
export function _resetPriceCaches() {
  spotCache = null;
  secondCache = null;
  secondWarnedAt = 0;
}

/// How old a price may be when a position is opened or closed, and that it is
/// checked against the second feed.
export const MONEY_PRICE_MAX_AGE_MS = 5 * 60_000;
const MONEY_PRICE = { maxStaleMs: MONEY_PRICE_MAX_AGE_MS, verify: true } as const;

/// Hourly ETH/USD candles for the last week (the advanced chart), cached 5 min.
export async function ethCandles(): Promise<Candle[]> {
  if (candleCache && Date.now() - candleCache.at < 300_000) return candleCache.candles;
  const res = await fetch("https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600", {
    headers: { "user-agent": "takarabako" },
    signal: AbortSignal.timeout(8000),
  });
  const rows = (await res.json()) as number[][];
  const candles = rows
    .slice(0, 168)
    .map(([t, l, h, o, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c! }))
    .reverse();
  candleCache = { at: Date.now(), candles };
  return candles;
}

// ---- strategies ------------------------------------------------------------

interface StoredStrategy {
  order: string; // encoded SwapVM order (the Aqua strategy bytes)
  hash: string; // Aqua strategy hash
  min: number | null;
  max: number | null;
  weight: number;
  eth: string; // shipped amounts (raw)
  usdc: string;
  shipTx: string;
}

export function buildOrder(bin: { min: number; max: number } | null, feeBps: number) {
  const maker = new sv.Address(treasuryAddress!);
  const strategy = bin
    ? (() => {
        const [sqrtPriceMin, sqrtPriceMax] = sqrtBounds(bin.min, bin.max, PAIR);
        return sv.AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin, sqrtPriceMax });
      })()
    : sv.AquaXYCAmmStrategy.new();
  // A random salt makes every strategy hash unique, even for identical ranges.
  const salt = BigInt(Math.floor(Math.random() * 2 ** 48)) * 65536n + BigInt(Date.now() % 65536);
  const program = strategy.withFeeTokenIn(feeBps).withSalt(salt).build();
  return sv.Order.new({ maker, program, traits: sv.MakerTraits.default() });
}

const aquaContract = () => new aq.AquaProtocolContract(new aq.Address(config.aqua.address));
const asTx = (tx: { to: { toString(): string }; data: { toString(): string } }) => ({
  to: tx.to.toString() as Address,
  data: tx.data.toString() as `0x${string}`,
});

/// Sets what `spender` may pull of `token` from the treasury to a size that
/// matches `need` (see allowances.ts): raised when short, lowered when far
/// too large (an old unlimited approval), otherwise left alone.
export async function ensureAllowance(token: Address, spender: Address, need: bigint, canLower = true): Promise<{ from: bigint; to: bigint } | null> {
  const current = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [treasuryAddress!, spender] });
  const action = allowanceAction(current, need, canLower);
  if (action.kind === "none") return null;
  await sendTreasuryTx({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, action.amount] }) });
  return { from: current, to: action.amount };
}

/// What the open (and closing) strategies hold in Aqua right now: the most
/// they could pay out. `complete` is false if any balance could not be read,
/// in which case the total is only a lower bound.
async function owedBalances(): Promise<{ eth: bigint; usdc: bigint; complete: boolean }> {
  let rows: Array<{ strategies: StoredStrategy[] }>;
  try {
    rows = (await pool.query("select strategies from aqua_positions where status in ('open', 'closing')")).rows;
  } catch {
    return { eth: 0n, usdc: 0n, complete: false };
  }
  const hashes = rows.flatMap((r) => r.strategies.map((s) => s.hash));
  let eth = 0n;
  let usdc = 0n;
  let complete = true;
  for (let i = 0; i < hashes.length; i += 8) {
    const got = await Promise.all(hashes.slice(i, i + 8).map((h) => retryOnLag(() => strategyBalances(h)).catch(() => null)));
    for (const b of got) {
      if (!b) complete = false;
      else {
        eth += b.eth;
        usdc += b.usdc;
      }
    }
  }
  return { eth, usdc, complete };
}

/// Refuses to open a position the treasury could not pay out. Aqua only records
/// virtual balances; the tokens stay in the treasury wallet and are pulled when
/// a swap fills, so the wallet balance is the real limit. Counts every open
/// strategy plus the one about to be shipped, and the USD about to arrive from
/// the customer's vault. If some balance cannot be read the check cannot be
/// made and is skipped (and logged). `owedNow` is for tests and scripts.
export async function assertBacked(extra: Amounts, incoming: Amounts, owedNow?: Amounts & { complete: boolean }) {
  const owed = owedNow ?? (await owedBalances());
  if (!owed.complete) {
    console.warn("[aqua] could not read every open strategy's balance: skipping the token cover check");
    return;
  }
  const [eth, usdc] = await Promise.all(
    [PAIR.eth.address, PAIR.usdc.address].map((token) =>
      publicClient.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [treasuryAddress!] }),
    ),
  );
  const short = backingShortfall({ eth, usdc }, owed, extra, incoming);
  if (short.eth === 0n && short.usdc === 0n) return;
  const missing = [
    short.eth > 0n ? `${formatUnits(short.eth, Number(PAIR.eth.decimals))} ETH` : null,
    short.usdc > 0n ? `${formatUnits(short.usdc, Number(PAIR.usdc.decimals))} USDC` : null,
  ].filter(Boolean);
  throw new GuardError(`the treasury does not hold enough tokens to back this position (short by ${missing.join(" and ")}): try again later`);
}

let approvalLock: Promise<unknown> = Promise.resolve();

/// Keeps Aqua's allowance on each pair token sized to what the open strategies
/// could pay out, plus `extra`: what is about to be shipped. Aqua pulls the
/// token a swap pays out from the treasury wallet, so this is the most it can
/// take. Runs one at a time. Returns what it changed.
export function ensureApprovals(extra: { eth: bigint; usdc: bigint } = { eth: 0n, usdc: 0n }): Promise<Array<{ token: string; from: bigint; to: bigint }>> {
  const run = approvalLock.then(async () => {
    const owed = await owedBalances();
    const changes = [];
    for (const [token, need] of [
      [PAIR.eth.address, owed.eth + extra.eth],
      [PAIR.usdc.address, owed.usdc + extra.usdc],
    ] as Array<[string, bigint]>) {
      const change = await ensureAllowance(token as Address, config.aqua.address as Address, need, owed.complete);
      if (change) changes.push({ token, ...change });
    }
    return changes;
  });
  approvalLock = run.catch(() => {});
  return run;
}

/// Re-checks the allowances on a timer, so growth from swaps (and closed
/// positions) is followed without waiting for the next position to open.
export function startApprovalKeeper(intervalMs = 5 * 60_000) {
  if (!aquaReady) return;
  const tick = () =>
    ensureApprovals()
      .then((c) => c.length && console.log(`[aqua] allowances: ${c.map((x) => `${x.token.slice(0, 8)}… ${x.from > 10n ** 30n ? "unlimited" : x.from} → ${x.to}`).join("; ")}`))
      .catch((err) => console.error("[aqua] allowance check failed:", err instanceof Error ? err.message.split("\n")[0] : err));
  setTimeout(tick, 15_000);
  setInterval(tick, intervalMs);
}

export async function shipBin(bin: Bin | null, usd: number, spot: number, feeBps: number): Promise<StoredStrategy> {
  const { eth, usdc } = allocate(usd, bin, spot, PAIR);
  const order = buildOrder(bin, feeBps);
  const encoded = order.encode().toString();
  const tx = aquaContract().ship({
    app: new aq.Address(config.aqua.router),
    strategy: new aq.HexString(encoded),
    amountsAndTokens: [
      { token: new aq.Address(PAIR.eth.address), amount: eth },
      { token: new aq.Address(PAIR.usdc.address), amount: usdc },
    ],
  });
  // Sent, not awaited: the caller waits for all bins together.
  const shipTx = await sendTreasuryTxNoWait(asTx(tx));
  return {
    order: encoded,
    hash: aq.AquaProtocolContract.calculateStrategyHash(new aq.HexString(encoded)).toString(),
    min: bin?.min ?? null,
    max: bin?.max ?? null,
    weight: bin?.weight ?? 1,
    eth: eth.toString(),
    usdc: usdc.toString(),
    shipTx,
  };
}

/// A strategy's current virtual balances in Aqua (they move with every swap).
export async function strategyBalances(hash: string): Promise<{ eth: bigint; usdc: bigint }> {
  const read = (token: string) =>
    publicClient.readContract({
      address: config.aqua.address as Address,
      abi: aquaAbi,
      functionName: "rawBalances",
      args: [treasuryAddress!, config.aqua.router as Address, hash as `0x${string}`, token as Address],
    });
  const [[eth], [usdc]] = await Promise.all([read(PAIR.eth.address), read(PAIR.usdc.address)]);
  return { eth: BigInt(eth), usdc: BigInt(usdc) };
}

// ---- positions -------------------------------------------------------------

export interface PositionRow {
  id: string;
  privyUserId: string;
  mode: Tier | "advanced";
  shape: Shape;
  priceMin: number | null;
  priceMax: number | null;
  spotOpen: number;
  amountUsd: number;
  feeBps: number;
  apyEstBps: number;
  strategies: StoredStrategy[];
  rationale: string | null;
  status: "open" | "closing" | "closed";
  vaultTx: string | null;
  closeValue: number | null;
  closeTx: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

const COLUMNS = `id, privy_user_id as "privyUserId", mode, shape, price_min::float as "priceMin", price_max::float as "priceMax",
  spot_open::float as "spotOpen", amount_usd::float as "amountUsd", fee_bps as "feeBps", apy_est_bps as "apyEstBps",
  strategies, rationale, status, vault_tx as "vaultTx", close_value::float as "closeValue", close_tx as "closeTx",
  created_at as "createdAt", closed_at as "closedAt"`;

export interface OpenRequest {
  privyUserId: string;
  boundAddress: string;
  amount: number;
  mode: Tier | "advanced";
  shape?: Exclude<Shape, "full">;
  priceMin?: number;
  priceMax?: number;
  hybrid?: HybridOptions;
  rationale?: string | null;
}

/// Validates an advanced range against the current price (−90% … +300%).
export function checkAdvancedRange(min: number, max: number, spot: number) {
  if (!(min > 0 && max > min)) throw new Error("the range needs a lower price below the upper price");
  if (min < spot * ADVANCED.minFractionOfSpot) throw new Error(`the lower price can't be more than 90% below today's price ($${(spot * ADVANCED.minFractionOfSpot).toFixed(0)})`);
  if (max > spot * ADVANCED.maxMultipleOfSpot) throw new Error(`the upper price can't be above $${(spot * ADVANCED.maxMultipleOfSpot).toFixed(0)}`);
}

/// Plans a position's bins without touching the chain (also used to preview).
export function planPosition(req: Pick<OpenRequest, "mode" | "shape" | "priceMin" | "priceMax" | "hybrid">, spot: number) {
  if (req.mode !== "advanced") {
    const plan = TIERS[req.mode];
    const bins: (Bin | null)[] = plan.rangePct === null
      ? [null]
      : [{ min: spot * (1 - plan.rangePct / 100), max: spot * (1 + plan.rangePct / 100), weight: 1 }];
    return { shape: (plan.rangePct === null ? "full" : "spot") as Shape, bins, feeBps: plan.feeBps, apyEstBps: plan.apyEstBps };
  }
  const shape = req.shape ?? "spot";
  const min = Number(req.priceMin);
  const max = Number(req.priceMax);
  checkAdvancedRange(min, max, spot);
  return { shape: shape as Shape, bins: binsFor(shape, min, max, spot, ADVANCED.bins, req.hybrid) as (Bin | null)[], feeBps: ADVANCED.feeBps, apyEstBps: ADVANCED.apyEstBps };
}

export async function openPosition(req: OpenRequest): Promise<PositionRow> {
  if (!aquaReady || !treasuryAddress) throw new Error(aquaUnavailableReason() ?? "cannot open an Aqua position");
  const spot = await ethUsd(MONEY_PRICE);
  const plan = planPosition(req, spot);
  // Before any money leaves the box: a strategy under a cent is not placed, so this amount must fund them all.
  try {
    assertFunds(plan.bins, req.amount);
  } catch (err) {
    throw Object.assign(err as Error, { status: 422 });
  }
  // Aqua may pull what these strategies can pay out: make sure it is allowed to,
  // and no more than that, before any of them is shipped.
  const extra = { eth: 0n, usdc: 0n };
  for (const bin of plan.bins) {
    const usd = req.amount * (bin?.weight ?? 1);
    if (usd < 0.01) continue;
    const a = allocate(usd, bin, spot, PAIR);
    extra.eth += a.eth;
    extra.usdc += a.usdc;
  }
  await assertBacked(extra, { eth: 0n, usdc: parseUnits(req.amount.toFixed(6), 6) });
  await ensureApprovals(extra);

  // Take the amount out of the customer's vault first; it funds the strategies.
  const { txHash: vaultTx } = await withdrawUsdOnChain(req.boundAddress as Address, treasuryAddress, req.amount);
  const strategies: StoredStrategy[] = [];
  try {
    for (const bin of plan.bins) {
      const usd = req.amount * (bin?.weight ?? 1);
      if (usd < 0.01) continue;
      strategies.push(await shipBin(bin, usd, spot, plan.feeBps));
    }
    await Promise.all(strategies.map((s) => waitForTx(s.shipTx as `0x${string}`)));
  } catch (err) {
    // Undo: dock anything shipped and put the money back in the vault.
    await dockAll(strategies).catch(() => {});
    await depositOnChain(req.boundAddress as Address, req.amount).catch((e) => console.error("[aqua] refund failed:", e));
    throw err;
  }

  const range = plan.bins.filter((b): b is Bin => b !== null);
  const { rows } = await pool.query(
    `insert into aqua_positions (id, privy_user_id, mode, shape, price_min, price_max, spot_open, amount_usd, fee_bps, apy_est_bps, strategies, rationale, vault_tx)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning ${COLUMNS}`,
    [
      crypto.randomUUID(),
      req.privyUserId,
      req.mode,
      plan.shape,
      range.length ? Math.min(...range.map((b) => b.min)) : null,
      range.length ? Math.max(...range.map((b) => b.max)) : null,
      spot,
      req.amount,
      plan.feeBps,
      plan.apyEstBps,
      JSON.stringify(strategies),
      req.rationale ?? null,
      vaultTx,
    ],
  );
  return rows[0];
}

export async function dockAll(strategies: StoredStrategy[]) {
  const hashes: `0x${string}`[] = [];
  for (const s of strategies) {
    const tx = aquaContract().dock({
      app: new aq.Address(config.aqua.router),
      strategyHash: new aq.HexString(s.hash),
      tokens: [new aq.Address(PAIR.eth.address), new aq.Address(PAIR.usdc.address)],
    });
    // Gas estimation can reach an RPC node that has not seen the strategy's
    // ship (or an earlier swap) yet and revert; the same call works moments later.
    hashes.push(await retryOnLag(() => sendTreasuryTxNoWait(asTx(tx))));
  }
  await Promise.all(hashes.map((h) => waitForTx(h)));
}

export interface PositionView extends Omit<PositionRow, "strategies"> {
  label: string;
  valueUsd: number | null; // live, at today's ETH price
  pnlUsd: number | null;
  inRange: boolean | null;
  spot: number;
  eth: number;
  usdc: number;
  bins: Array<{ min: number | null; max: number | null; weight: number; eth: number; usdc: number; valueUsd: number }>;
}

/// A position with its live Aqua balances valued at today's price.
export async function viewPosition(p: PositionRow, spot: number): Promise<PositionView> {
  const bins = await Promise.all(
    p.strategies.map(async (s) => {
      const bal = p.status === "open" ? await strategyBalances(s.hash).catch(() => null) : null;
      const eth = bal ? bal.eth : 0n;
      const usdc = bal ? bal.usdc : 0n;
      return { min: s.min, max: s.max, weight: s.weight, eth: Number(eth) / 1e18, usdc: Number(usdc) / 1e6, valueUsd: valueUsd(eth, usdc, spot, PAIR) };
    }),
  );
  const { strategies: _s, ...rest } = p;
  const open = p.status === "open";
  const value = open ? bins.reduce((s, b) => s + b.valueUsd, 0) : p.closeValue;
  return {
    ...rest,
    label: p.mode === "advanced" ? `Advanced · ${p.shape === "bidask" ? "Bid-Ask" : p.shape === "curve" ? "Curve" : p.shape === "hybrid" ? "Hybrid" : "Spot"}` : TIERS[p.mode].label,
    valueUsd: value,
    pnlUsd: value === null ? null : value - p.amountUsd,
    inRange: !open ? null : p.priceMin === null || p.priceMax === null ? true : spot >= p.priceMin && spot <= p.priceMax,
    spot,
    eth: bins.reduce((s, b) => s + b.eth, 0),
    usdc: bins.reduce((s, b) => s + b.usdc, 0),
    bins,
  };
}

export async function listPositions(privyUserId: string, status: "open" | "all" = "open"): Promise<PositionRow[]> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from aqua_positions where privy_user_id = $1 ${status === "open" ? "and status in ('open', 'closing')" : ""} order by created_at desc limit 50`,
    [privyUserId],
  );
  return rows;
}

export async function openPositions(): Promise<PositionRow[]> {
  const { rows } = await pool.query(`select ${COLUMNS} from aqua_positions where status = 'open' order by created_at desc limit 100`);
  return rows;
}

/// A position's value from Aqua's live balances, read strictly: unlike the
/// display (viewPosition), a failed read must not count as "worth nothing",
/// because the result is what the customer is paid.
export async function liveValueStrict(p: PositionRow): Promise<number> {
  const spot = await ethUsd(MONEY_PRICE);
  const bals = await Promise.all(p.strategies.map((s) => retryOnLag(() => strategyBalances(s.hash))));
  // Aqua keeps a shipped strategy's balances until it is docked, so all-zero
  // means the read was wrong (or it was already docked): never pay out on it.
  if (bals.every((b) => b.eth === 0n && b.usdc === 0n)) throw new Error("could not read this position's balances from Aqua — try again in a moment");
  const eth = bals.reduce((s, b) => s + b.eth, 0n);
  const usdc = bals.reduce((s, b) => s + b.usdc, 0n);
  return floorMicros(valueUsd(eth, usdc, spot, PAIR));
}

/// Docks the strategies that still hold balances, so a retry after a partial
/// close does not try to dock one twice.
export async function dockRemaining(strategies: StoredStrategy[]) {
  const todo: StoredStrategy[] = [];
  for (const s of strategies) {
    const b = await retryOnLag(() => strategyBalances(s.hash));
    if (b.eth !== 0n || b.usdc !== 0n) todo.push(s);
  }
  if (todo.length) await dockAll(todo);
}

/// Sends the recorded payout to the customer's vault exactly once. close_tx
/// says where a previous try got to (see closeFlow.ts).
async function payOut(id: string, to: Address, value: number): Promise<string> {
  const { rows } = await pool.query("select close_tx from aqua_positions where id = $1", [id]);
  const step = payoutStep(rows[0]?.close_tx ?? null);
  if (step.kind === "blocked") throw new Error(step.reason);
  if (step.kind === "verify") {
    const receipt = await publicClient.getTransactionReceipt({ hash: step.hash }).catch(() => null);
    if (!receipt) {
      await waitForTx(step.hash); // sent, not mined yet
      return step.hash;
    }
    if (receipt.status === "success") return step.hash;
    // It reverted, so nothing was paid: clear it and send again.
    await pool.query("update aqua_positions set close_tx = null where id = $1 and close_tx = $2", [id, step.hash]);
  }
  // Only one request gets to send.
  const claim = await pool.query("update aqua_positions set close_tx = $2 where id = $1 and close_tx is null", [id, PAYOUT_PENDING]);
  if (claim.rowCount !== 1) throw new Error("this position's payout is already being sent");
  let hash: `0x${string}`;
  try {
    hash = await retryOnLag(() => sendDepositTx(to, value));
  } catch (err) {
    // A reverted estimate means nothing was broadcast, so release the claim.
    // Any other failure may have left a transaction in flight: keep it blocked.
    if (looksLikeRpcLag(err)) await pool.query("update aqua_positions set close_tx = null where id = $1 and close_tx = $2", [id, PAYOUT_PENDING]);
    throw err;
  }
  await pool.query("update aqua_positions set close_tx = $2 where id = $1", [id, hash]);
  await waitForDepositTx(hash, to);
  return hash;
}

/// Closes a position and returns its value to the customer's vault, in steps
/// that survive stopping halfway: the payout is fixed and recorded before any
/// strategy is docked, and closing again resumes a "closing" position.
export async function closePosition(p: PositionRow, boundAddress: string): Promise<{ value: number; closeTx: string | null }> {
  if (p.status === "closed") throw new Error("position is already closed");

  let value: number;
  if (p.status === "open") {
    value = await liveValueStrict(p);
    const claim = await pool.query("update aqua_positions set status = 'closing', close_value = $2, closing_at = now() where id = $1 and status = 'open'", [p.id, value]);
    if (claim.rowCount !== 1) throw new Error("position is already being closed");
  } else {
    if (p.closeValue === null) throw new Error("this position is closing but has no recorded payout: check it by hand");
    value = p.closeValue;
  }

  await dockRemaining(p.strategies);
  const closeTx = value > 0 ? await payOut(p.id, boundAddress as Address, value) : null;
  await pool.query("update aqua_positions set status = 'closed', close_tx = $2, closed_at = now() where id = $1", [p.id, closeTx]);
  return { value, closeTx };
}
