import { parseAbi, type Address } from "viem";
import { config } from "./config.js";
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
  type Tier,
} from "./aquaMath.js";
import {
  chainReady,
  depositOnChain,
  publicClient,
  sendTreasuryTx,
  sendTreasuryTxNoWait,
  treasuryAddress,
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

export const aquaReady = chainReady && Boolean(config.aqua.methAddress && config.usdcAddress);

const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)"]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
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

/// Live ETH/USD, cached 30s. mETH is priced off real ETH.
export async function ethUsd(): Promise<number> {
  if (spotCache && Date.now() - spotCache.at < 30_000) return spotCache.price;
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(5000) });
    const price = Number((await res.json()).data.amount);
    if (!(price > 0)) throw new Error("bad price");
    spotCache = { at: Date.now(), price };
    return price;
  } catch (err) {
    if (spotCache) return spotCache.price; // stale beats nothing
    throw new Error(`ETH price unavailable: ${err instanceof Error ? err.message : err}`);
  }
}

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

function buildOrder(bin: { min: number; max: number } | null, feeBps: number) {
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

let approvalsChecked = false;

/// Aqua pulls from the maker's wallet during swaps, so the treasury approves
/// it once per token.
async function ensureApprovals() {
  if (approvalsChecked) return;
  for (const token of [PAIR.eth.address, PAIR.usdc.address] as Address[]) {
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [treasuryAddress!, config.aqua.address as Address] });
    if (allowance < 10n ** 40n) {
      const { encodeFunctionData, maxUint256 } = await import("viem");
      await sendTreasuryTx({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.aqua.address as Address, maxUint256] }) });
    }
  }
  approvalsChecked = true;
}

async function shipBin(bin: Bin | null, usd: number, spot: number, feeBps: number): Promise<StoredStrategy> {
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
  status: "open" | "closed";
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
  rationale?: string | null;
}

/// Validates an advanced range against the current price (−90% … +300%).
export function checkAdvancedRange(min: number, max: number, spot: number) {
  if (!(min > 0 && max > min)) throw new Error("the range needs a lower price below the upper price");
  if (min < spot * ADVANCED.minFractionOfSpot) throw new Error(`the lower price can't be more than 90% below today's price ($${(spot * ADVANCED.minFractionOfSpot).toFixed(0)})`);
  if (max > spot * ADVANCED.maxMultipleOfSpot) throw new Error(`the upper price can't be above $${(spot * ADVANCED.maxMultipleOfSpot).toFixed(0)}`);
}

/// Plans a position's bins without touching the chain (also used to preview).
export function planPosition(req: Pick<OpenRequest, "mode" | "shape" | "priceMin" | "priceMax">, spot: number) {
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
  return { shape: shape as Shape, bins: binsFor(shape, min, max, spot) as (Bin | null)[], feeBps: ADVANCED.feeBps, apyEstBps: ADVANCED.apyEstBps };
}

export async function openPosition(req: OpenRequest): Promise<PositionRow> {
  if (!aquaReady || !treasuryAddress) throw new Error("chain not configured — cannot open an Aqua position");
  const spot = await ethUsd();
  const plan = planPosition(req, spot);
  await ensureApprovals();

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

async function dockAll(strategies: StoredStrategy[]) {
  const hashes: `0x${string}`[] = [];
  for (const s of strategies) {
    const tx = aquaContract().dock({
      app: new aq.Address(config.aqua.router),
      strategyHash: new aq.HexString(s.hash),
      tokens: [new aq.Address(PAIR.eth.address), new aq.Address(PAIR.usdc.address)],
    });
    hashes.push(await sendTreasuryTxNoWait(asTx(tx)));
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
    label: p.mode === "advanced" ? `Advanced · ${p.shape === "bidask" ? "Bid-Ask" : p.shape === "curve" ? "Curve" : "Spot"}` : TIERS[p.mode].label,
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
    `select ${COLUMNS} from aqua_positions where privy_user_id = $1 ${status === "open" ? "and status = 'open'" : ""} order by created_at desc limit 50`,
    [privyUserId],
  );
  return rows;
}

export async function openPositions(): Promise<PositionRow[]> {
  const { rows } = await pool.query(`select ${COLUMNS} from aqua_positions where status = 'open' order by created_at desc limit 100`);
  return rows;
}

/// Docks a position's strategies and returns their value to the vault.
export async function closePosition(p: PositionRow, boundAddress: string): Promise<{ value: number; closeTx: string | null }> {
  if (p.status !== "open") throw new Error("position is already closed");
  const spot = await ethUsd();
  const view = await viewPosition(p, spot);
  await dockAll(p.strategies);
  const value = Math.max(0, Math.floor((view.valueUsd ?? 0) * 1e6) / 1e6);
  const closeTx = value > 0 ? (await depositOnChain(boundAddress as Address, value)).txHash : null;
  await pool.query(
    "update aqua_positions set status = 'closed', close_value = $2, close_tx = $3, closed_at = now() where id = $1",
    [p.id, value, closeTx],
  );
  return { value, closeTx };
}
