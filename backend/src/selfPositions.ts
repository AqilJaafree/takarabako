import { formatUnits, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import type { Account } from "./accounts.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ethUsd, MONEY_PRICE_MAX_AGE_MS } from "./aqua.js";
import { selfBins, type SelfShape } from "./selfShapes.js";
import { valueUsd } from "./aquaMath.js";
import { GuardError } from "./guards.js";
import { applyFeeFloor } from "./networks.js";
import { retryOnLag } from "./retry.js";
import { matchesPrepared, managerAbi, planManagerClose, planManagerOpen, planSelfClose, planSelfOpen, type Amounts, type SelfStrategy, type Step } from "./selfCustody.js";
import { selfClient, type SelfNet } from "./selfChain.js";

/// Self-custody Aqua positions: prepare what the customer's wallet signs, check on chain that it
/// did, and read the position's live value. The backend never holds a key for this: it builds
/// transactions, the customer's own wallet signs and sends them, and the backend verifies the result.
///
/// Two ways to hold a position, chosen by whether the chain has an AquaPositionManager:
///  - without one (Arc today), the wallet is the Aqua maker: it approves Aqua, then ships and docks
///    each strategy itself, and the tokens never leave it;
///  - with one (Sepolia), the manager is the maker: the wallet approves the manager once, `open`
///    pulls the tokens in and ships every strategy in one transaction, and `close` docks them all
///    and sends everything back. The tokens sit in the manager while the position is open.

/// What a position was opened as: its shape (the range it covers is stored beside it).
export type SelfMode = SelfShape;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)"]);

const deployment = (net: SelfNet) => {
  if (!net.aqua || !net.router) throw new GuardError(`1inch Aqua is not available on ${net.name}`);
  return { aqua: net.aqua, router: net.router };
};

export interface SelfRow {
  id: string;
  privyUserId: string;
  wallet: string;
  chainId: number;
  /// The AquaPositionManager that holds this position, or null when the wallet itself is the maker.
  manager: string | null;
  /// The position's id inside the manager (known once it is open).
  managerPositionId: string | null;
  mode: SelfMode;
  amountUsd: number;
  spotOpen: number;
  feeBps: number;
  priceMin: number | null;
  priceMax: number | null;
  strategies: SelfStrategy[];
  /// The transactions prepared for the customer to sign (what recordOpen checks against).
  steps: Step[] | null;
  status: "pending" | "open" | "closed";
  openTxs: string[] | null;
  closeTxs: string[] | null;
  createdAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
}

const COLUMNS = `id, privy_user_id as "privyUserId", wallet, chain_id as "chainId", manager, manager_position_id::text as "managerPositionId",
  mode, amount_usd::float as "amountUsd",
  spot_open::float as "spotOpen", fee_bps as "feeBps", price_min::float as "priceMin", price_max::float as "priceMax",
  strategies, steps, status, open_txs as "openTxs", close_txs as "closeTxs", created_at as "createdAt", opened_at as "openedAt", closed_at as "closedAt"`;

/// Who the strategies are made for in Aqua: the manager if the position is held by one, else the wallet.
const makerOf = (row: Pick<SelfRow, "manager" | "wallet">) => (row.manager ?? row.wallet) as Address;

/// The tokens a customer's wallet holds on the chain, what is already approved (to the manager, or to
/// Aqua without one), and what its open strategies could already pay out.
export async function walletState(net: SelfNet, wallet: string) {
  const c = selfClient(net);
  const w = wallet as Address;
  const spender = net.manager ?? deployment(net).aqua;
  const [usdc, weth, native, aUsdc, aWeth] = await Promise.all([
    c.readContract({ address: net.pair.usdc.address as Address, abi: erc20, functionName: "balanceOf", args: [w] }),
    c.readContract({ address: net.pair.eth.address as Address, abi: erc20, functionName: "balanceOf", args: [w] }),
    c.getBalance({ address: w }),
    c.readContract({ address: net.pair.usdc.address as Address, abi: erc20, functionName: "allowance", args: [w, spender] }),
    c.readContract({ address: net.pair.eth.address as Address, abi: erc20, functionName: "allowance", args: [w, spender] }),
  ]);
  // A manager pulls the tokens in when the position opens, so nothing is left owed from the wallet.
  const owed = net.manager ? { eth: 0n, usdc: 0n } : await owedBy(net, wallet);
  return { address: wallet, usdc, weth, gasNative: native, allowance: { eth: aWeth, usdc: aUsdc } as Amounts, owed };
}

async function strategyBalances(net: SelfNet, maker: string, hash: string): Promise<Amounts> {
  const c = selfClient(net);
  const { router, aqua } = deployment(net);
  const read = (token: string) =>
    c.readContract({ address: aqua, abi: aquaAbi, functionName: "rawBalances", args: [maker as Address, router, hash as Hex, token as Address] });
  const [[eth], [usdc]] = await Promise.all([read(net.pair.eth.address), read(net.pair.usdc.address)]);
  return { eth: BigInt(eth), usdc: BigInt(usdc) };
}

/// What this wallet's own open strategies could pay out right now (wallet-as-maker positions only).
async function owedBy(net: SelfNet, wallet: string): Promise<Amounts> {
  const { rows } = await pool.query("select strategies from self_positions where wallet = $1 and chain_id = $2 and manager is null and status = 'open'", [wallet, net.chainId]);
  let eth = 0n;
  let usdc = 0n;
  for (const r of rows as Array<{ strategies: SelfStrategy[] }>) {
    for (const s of r.strategies) {
      const b = await retryOnLag(() => strategyBalances(net, wallet, s.hash));
      eth += b.eth;
      usdc += b.usdc;
    }
  }
  return { eth, usdc };
}

/// Fees for a transaction: Arc's mempool silently drops anything under 20 gwei, so the customer's
/// wallet is told what to pay instead of guessing.
async function fees(net: SelfNet) {
  const f = applyFeeFloor(await selfClient(net).estimateFeesPerGas(), net.minMaxFeePerGas);
  const hex = (v: bigint) => `0x${v.toString(16)}`;
  return { maxFeePerGas: hex((f.maxFeePerGas! * 13n) / 10n), maxPriorityFeePerGas: hex(f.maxPriorityFeePerGas ?? 0n) };
}

export interface PreparedStep extends Step {
  chainId: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

const withFees = async (net: SelfNet, steps: Step[]): Promise<PreparedStep[]> => {
  const f = await fees(net);
  return steps.map((s) => ({ ...s, chainId: net.chainId, ...f }));
};

const fmtUnits = (v: bigint, decimals: bigint) => formatUnits(v, Number(decimals));

/// Plans a position and the transactions to sign. Refuses, before anything is
/// signed, if the wallet cannot cover it or the price cannot be trusted.
export async function prepareOpen(net: SelfNet, account: Account, req: { shape: SelfShape; priceMin?: number; priceMax?: number; amount: number; wallet?: string }) {
  if (!(req.amount > 0) || req.amount < 5) throw Object.assign(new Error("the amount must be at least $5"), { status: 422 });
  if (req.amount > config.selfCustody.maxUsd) throw Object.assign(new Error(`positions are capped at $${config.selfCustody.maxUsd} for now`), { status: 422 });

  const spot = await ethUsd({ maxStaleMs: MONEY_PRICE_MAX_AGE_MS, verify: true });
  let plan: ReturnType<typeof selfBins>;
  try {
    plan = selfBins(req.shape, spot, req.priceMin, req.priceMax);
  } catch (e) {
    throw Object.assign(new Error(e instanceof Error ? e.message : "invalid range"), { status: 422 });
  }
  // The wallet that signs: the customer's own choice (their Takarabako wallet or one they connected, such as
  // MetaMask), or the Takarabako wallet by default. Whoever it is, recording the position needs these exact
  // transactions sent from it (verifySigned), so naming a wallet does not let anyone act for it.
  const wallet = (req.wallet ?? account.privyWallet).toLowerCase();
  const state = await walletState(net, wallet);
  const { aqua, router } = deployment(net);
  const built = net.manager
    ? planManagerOpen({ wallet: wallet as Address, manager: net.manager, amountUsd: req.amount, bins: plan.bins, feeBps: plan.feeBps, spot, pair: net.pair, allowance: state.allowance, symbols: net.symbols })
    : planSelfOpen({ maker: wallet as Address, amountUsd: req.amount, bins: plan.bins, feeBps: plan.feeBps, spot, pair: net.pair, aqua, router, allowance: state.allowance, owed: state.owed });

  const short: string[] = [];
  if (state.usdc < built.need.usdc) short.push(`${fmtUnits(built.need.usdc, 6n)} ${net.symbols.quote} (it holds ${fmtUnits(state.usdc, 6n)})`);
  if (state.weth < built.need.eth) short.push(`${fmtUnits(built.need.eth, 18n)} ${net.symbols.base} (it holds ${fmtUnits(state.weth, 18n)})`);
  if (short.length) throw Object.assign(new Error(`your wallet needs ${short.join(" and ")} on ${net.name} to open this position`), { status: 422 });
  if (state.gasNative < net.minGasWei) throw Object.assign(new Error(`your wallet needs at least ${fmtUnits(net.minGasWei, 18n)} ${net.symbols.gas} on ${net.name} to pay for the transactions`), { status: 422 });

  const id = crypto.randomUUID();
  const range = built.strategies.filter((s) => s.min !== null);
  await pool.query(
    `insert into self_positions (id, privy_user_id, wallet, chain_id, manager, mode, amount_usd, spot_open, fee_bps, price_min, price_max, strategies, steps)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, account.privyUserId, wallet, net.chainId, net.manager, req.shape, req.amount, spot, plan.feeBps, range.length ? Math.min(...range.map((s) => s.min!)) : null, range.length ? Math.max(...range.map((s) => s.max!)) : null, JSON.stringify(built.strategies), JSON.stringify(built.steps)],
  );
  return {
    positionId: id,
    steps: await withFees(net, built.steps),
    summary: { spot, usdc: fmtUnits(built.need.usdc, 6n), weth: fmtUnits(built.need.eth, 18n), strategies: built.strategies.length },
  };
}

/// Checks that these are the very transactions that were prepared, sent from the
/// customer's wallet and succeeded: every step must match one transaction by
/// target, data and sender.
async function verifySigned(net: SelfNet, wallet: string, steps: Step[], hashes: string[]) {
  if (hashes.length !== steps.length) throw new GuardError(`expected ${steps.length} transactions, got ${hashes.length}`);
  const c = selfClient(net);
  const txs = await Promise.all(hashes.map((h) => retryOnLag(() => c.getTransaction({ hash: h as Hex }), { tries: 6, delayMs: 2_000 })));
  if (!matchesPrepared(wallet, steps, txs)) throw new GuardError("these transactions are not the ones that were prepared for your wallet");
  for (const h of hashes) {
    const receipt = await c.waitForTransactionReceipt({ hash: h as Hex, timeout: 90_000, pollingInterval: 1_500 });
    if (receipt.status !== "success") throw new GuardError(`transaction ${h.slice(0, 10)}… failed on chain`);
  }
}

/// The manager's id for the position these transactions opened, read from the `Opened` event the
/// manager emitted. The event must name this wallet as owner and carry exactly the strategies that
/// were prepared, so a position cannot be bound to someone else's id.
async function managerPositionIdFrom(net: SelfNet, manager: string, wallet: string, strategies: SelfStrategy[], hashes: string[]): Promise<bigint> {
  const c = selfClient(net);
  for (const h of hashes) {
    const receipt = await c.getTransactionReceipt({ hash: h as Hex });
    const logs = parseEventLogs({ abi: managerAbi, eventName: "Opened", logs: receipt.logs.filter((l) => l.address.toLowerCase() === manager.toLowerCase()) });
    for (const log of logs) {
      const { id, owner, hashes: opened } = log.args;
      if (owner.toLowerCase() !== wallet.toLowerCase()) continue;
      const want = strategies.map((s) => s.hash.toLowerCase());
      if (opened.length === want.length && opened.every((x, i) => x.toLowerCase() === want[i])) return id;
    }
  }
  throw new GuardError("the position manager did not report opening these strategies for your wallet");
}

/// Waits until `ok` holds for every strategy's balances: public RPCs can be a
/// block behind right after a transaction.
async function settled(net: SelfNet, maker: string, strategies: SelfStrategy[], ok: (b: Amounts) => boolean) {
  for (let i = 0; i < 8; i++) {
    const all = await Promise.all(strategies.map((s) => strategyBalances(net, maker, s.hash)));
    if (all.every(ok)) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function ownRow(net: SelfNet, privyUserId: string, id: string): Promise<SelfRow> {
  const { rows } = await pool.query(`select ${COLUMNS} from self_positions where id = $1 and privy_user_id = $2 and chain_id = $3`, [id, privyUserId, net.chainId]);
  if (!rows[0]) throw Object.assign(new Error("no such position"), { status: 404 });
  return rows[0];
}

export async function recordOpen(net: SelfNet, account: Account, id: string, hashes: string[]) {
  const row = await ownRow(net, account.privyUserId, id);
  if (row.status === "open") return viewSelf(net, row);
  if (row.status !== "pending") throw Object.assign(new Error("this position is already closed"), { status: 409 });
  if (!row.steps) throw new GuardError("this position has no prepared transactions to check");
  await verifySigned(net, row.wallet, row.steps, hashes);
  let managerId: bigint | null = null;
  if (row.manager) managerId = await managerPositionIdFrom(net, row.manager, row.wallet, row.strategies, hashes);
  if (!(await settled(net, makerOf(row), row.strategies, (b) => b.eth > 0n || b.usdc > 0n)))
    throw new GuardError("the transactions went through, but Aqua does not show the strategies yet: try again in a moment");
  await pool.query("update self_positions set status = 'open', open_txs = $2, manager_position_id = $3, opened_at = now() where id = $1 and status = 'pending'", [id, JSON.stringify(hashes), managerId === null ? null : managerId.toString()]);
  return viewSelf(net, await ownRow(net, account.privyUserId, id));
}

/// The transactions that close a position, rebuilt from what is stored (never taken from the client).
function closeSteps(net: SelfNet, row: SelfRow): Step[] {
  if (row.manager) {
    if (row.managerPositionId === null) throw new GuardError("this position has no id in the position manager");
    return planManagerClose(row.manager as Address, BigInt(row.managerPositionId));
  }
  const { aqua, router } = deployment(net);
  return planSelfClose(row.strategies, net.pair, aqua, router);
}

export async function prepareClose(net: SelfNet, account: Account, id: string) {
  const row = await ownRow(net, account.privyUserId, id);
  if (row.status !== "open") throw Object.assign(new Error("this position is not open"), { status: 409 });
  return { positionId: id, steps: await withFees(net, closeSteps(net, row)) };
}

export async function recordClose(net: SelfNet, account: Account, id: string, hashes: string[]) {
  const row = await ownRow(net, account.privyUserId, id);
  if (row.status === "closed") return viewSelf(net, row);
  if (row.status !== "open") throw Object.assign(new Error("this position is not open"), { status: 409 });
  await verifySigned(net, row.wallet, closeSteps(net, row), hashes); // the closing transactions are rebuilt, not trusted
  if (!(await settled(net, makerOf(row), row.strategies, (b) => b.eth === 0n && b.usdc === 0n)))
    throw new GuardError("the transactions went through, but Aqua still shows balances: try again in a moment");
  await pool.query("update self_positions set status = 'closed', close_txs = $2, closed_at = now() where id = $1 and status = 'open'", [id, JSON.stringify(hashes)]);
  return viewSelf(net, await ownRow(net, account.privyUserId, id));
}

export async function listSelf(net: SelfNet, privyUserId: string) {
  const { rows } = await pool.query(
    `select ${COLUMNS} from self_positions where privy_user_id = $1 and chain_id = $2 and status in ('open', 'closed') order by created_at desc limit 20`,
    [privyUserId, net.chainId],
  );
  const spot = await ethUsd().catch(() => null);
  return Promise.all((rows as SelfRow[]).map((r) => viewSelf(net, r, spot)));
}

/// A position with its live balances, valued at today's price (display only).
export async function viewSelf(net: SelfNet, row: SelfRow, spotIn?: number | null) {
  const spot = spotIn === undefined ? await ethUsd().catch(() => null) : spotIn;
  let eth = 0n;
  let usdc = 0n;
  let readable = row.status === "open";
  if (row.status === "open") {
    for (const s of row.strategies) {
      try {
        const b = await strategyBalances(net, makerOf(row), s.hash);
        eth += b.eth;
        usdc += b.usdc;
      } catch {
        readable = false;
      }
    }
  }
  return {
    id: row.id,
    wallet: row.wallet,
    /// The contract holding the tokens while the position is open, or null when the wallet itself does.
    manager: row.manager,
    status: row.status,
    mode: row.mode,
    amountUsd: row.amountUsd,
    spotOpen: row.spotOpen,
    priceMin: row.priceMin,
    priceMax: row.priceMax,
    strategies: row.strategies.length,
    weth: Number(formatUnits(eth, 18)),
    usdc: Number(formatUnits(usdc, 6)),
    valueUsd: readable && spot ? valueUsd(eth, usdc, spot, net.pair) : null,
    openTxs: row.openTxs,
    closeTxs: row.closeTxs,
    createdAt: row.createdAt,
  };
}
