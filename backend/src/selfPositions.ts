import { createPublicClient, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { arc } from "viem/chains";
import type { Account } from "./accounts.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ethUsd, MONEY_PRICE_MAX_AGE_MS } from "./aqua.js";
import { selfBins, type SelfShape } from "./selfShapes.js";
import { valueUsd } from "./aquaMath.js";
import { GuardError } from "./guards.js";
import { applyFeeFloor, NETWORKS, resolveAquaDeployment } from "./networks.js";
import { retryOnLag } from "./retry.js";
import { ARC_CHAIN_ID, ARC_PAIR, matchesPrepared, planSelfClose, planSelfOpen, type Amounts, type SelfStrategy, type Step } from "./selfCustody.js";

/// Self-custody Aqua positions on Arc mainnet: prepare what the customer's wallet
/// signs, check on chain that it did, and read the position's live value. The
/// backend never holds a key for this: it builds transactions, the customer's
/// own wallet signs and sends them, and the backend verifies the result.

/// What a position was opened as: its shape (the range it covers is stored beside it).
export type SelfMode = SelfShape;

const arcClient = () => createPublicClient({ chain: arc, transport: http(config.selfCustody.arcRpcUrl, { timeout: 10_000 }) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)"]);

const deployment = () => {
  const d = resolveAquaDeployment(ARC_CHAIN_ID, {});
  if (!d) throw new GuardError("1inch Aqua is not available on Arc");
  return { aqua: d.aqua as Address, router: d.router as Address };
};

function assertEnabled() {
  if (!config.selfCustody.arcEnabled) throw Object.assign(new Error("signing with your own wallet on Arc is not turned on"), { status: 404 });
}

export interface SelfRow {
  id: string;
  privyUserId: string;
  wallet: string;
  chainId: number;
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

const COLUMNS = `id, privy_user_id as "privyUserId", wallet, chain_id as "chainId", mode, amount_usd::float as "amountUsd",
  spot_open::float as "spotOpen", fee_bps as "feeBps", price_min::float as "priceMin", price_max::float as "priceMax",
  strategies, steps, status, open_txs as "openTxs", close_txs as "closeTxs", created_at as "createdAt", opened_at as "openedAt", closed_at as "closedAt"`;

/// The tokens a customer's wallet holds on Arc, what Aqua may already pull, and
/// what its open strategies could already pay out.
export async function walletState(wallet: string) {
  assertEnabled();
  const c = arcClient();
  const w = wallet as Address;
  const { aqua } = deployment();
  const [usdc, weth, native, aUsdc, aWeth] = await Promise.all([
    c.readContract({ address: ARC_PAIR.usdc.address as Address, abi: erc20, functionName: "balanceOf", args: [w] }),
    c.readContract({ address: ARC_PAIR.eth.address as Address, abi: erc20, functionName: "balanceOf", args: [w] }),
    c.getBalance({ address: w }),
    c.readContract({ address: ARC_PAIR.usdc.address as Address, abi: erc20, functionName: "allowance", args: [w, aqua] }),
    c.readContract({ address: ARC_PAIR.eth.address as Address, abi: erc20, functionName: "allowance", args: [w, aqua] }),
  ]);
  const owed = await owedBy(wallet);
  return { address: wallet, usdc, weth, gasUsdc: native / 10n ** 12n, allowance: { eth: aWeth, usdc: aUsdc } as Amounts, owed };
}

async function strategyBalances(wallet: string, hash: string): Promise<Amounts> {
  const c = arcClient();
  const { router, aqua } = deployment();
  const read = (token: string) =>
    c.readContract({ address: aqua, abi: aquaAbi, functionName: "rawBalances", args: [wallet as Address, router, hash as Hex, token as Address] });
  const [[eth], [usdc]] = await Promise.all([read(ARC_PAIR.eth.address), read(ARC_PAIR.usdc.address)]);
  return { eth: BigInt(eth), usdc: BigInt(usdc) };
}

/// What this wallet's open strategies could pay out right now.
async function owedBy(wallet: string): Promise<Amounts> {
  const { rows } = await pool.query("select strategies from self_positions where wallet = $1 and status = 'open'", [wallet]);
  let eth = 0n;
  let usdc = 0n;
  for (const r of rows as Array<{ strategies: SelfStrategy[] }>) {
    for (const s of r.strategies) {
      const b = await retryOnLag(() => strategyBalances(wallet, s.hash));
      eth += b.eth;
      usdc += b.usdc;
    }
  }
  return { eth, usdc };
}

/// Fees for a transaction on Arc: its mempool silently drops anything under 20
/// gwei, so the customer's wallet is told what to pay instead of guessing.
async function arcFees() {
  const fees = applyFeeFloor(await arcClient().estimateFeesPerGas(), NETWORKS.arc.minMaxFeePerGas);
  const hex = (v: bigint) => `0x${v.toString(16)}`;
  return { maxFeePerGas: hex((fees.maxFeePerGas! * 13n) / 10n), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas ?? 0n) };
}

export interface PreparedStep extends Step {
  chainId: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

const withFees = async (steps: Step[]): Promise<PreparedStep[]> => {
  const f = await arcFees();
  return steps.map((s) => ({ ...s, chainId: ARC_CHAIN_ID, ...f }));
};

const fmtUnits = (v: bigint, decimals: bigint) => formatUnits(v, Number(decimals));

/// Plans a position and the transactions to sign. Refuses, before anything is
/// signed, if the wallet cannot cover it or the price cannot be trusted.
export async function prepareOpen(account: Account, req: { shape: SelfShape; priceMin?: number; priceMax?: number; amount: number; wallet?: string }) {
  assertEnabled();
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
  const state = await walletState(wallet);
  const { aqua, router } = deployment();
  const built = planSelfOpen({ maker: wallet as Address, amountUsd: req.amount, bins: plan.bins, feeBps: plan.feeBps, spot, pair: ARC_PAIR, aqua, router, allowance: state.allowance, owed: state.owed });

  const short: string[] = [];
  if (state.usdc < built.need.usdc) short.push(`${fmtUnits(built.need.usdc, 6n)} USDC (it holds ${fmtUnits(state.usdc, 6n)})`);
  if (state.weth < built.need.eth) short.push(`${fmtUnits(built.need.eth, 18n)} WETH (it holds ${fmtUnits(state.weth, 18n)})`);
  if (short.length) throw Object.assign(new Error(`your wallet needs ${short.join(" and ")} on Arc to open this position`), { status: 422 });
  if (state.gasUsdc < 500_000n) throw Object.assign(new Error("your wallet needs at least 0.5 USDC on Arc to pay for the transactions"), { status: 422 });

  const id = crypto.randomUUID();
  const range = built.strategies.filter((s) => s.min !== null);
  await pool.query(
    `insert into self_positions (id, privy_user_id, wallet, chain_id, mode, amount_usd, spot_open, fee_bps, price_min, price_max, strategies, steps)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, account.privyUserId, wallet, ARC_CHAIN_ID, req.shape, req.amount, spot, plan.feeBps, range.length ? Math.min(...range.map((s) => s.min!)) : null, range.length ? Math.max(...range.map((s) => s.max!)) : null, JSON.stringify(built.strategies), JSON.stringify(built.steps)],
  );
  return {
    positionId: id,
    steps: await withFees(built.steps),
    summary: { spot, usdc: fmtUnits(built.need.usdc, 6n), weth: fmtUnits(built.need.eth, 18n), strategies: built.strategies.length },
  };
}

/// Checks that these are the very transactions that were prepared, sent from the
/// customer's wallet and succeeded: every step must match one transaction by
/// target, data and sender.
async function verifySigned(wallet: string, steps: Step[], hashes: string[]) {
  if (hashes.length !== steps.length) throw new GuardError(`expected ${steps.length} transactions, got ${hashes.length}`);
  const c = arcClient();
  const txs = await Promise.all(hashes.map((h) => retryOnLag(() => c.getTransaction({ hash: h as Hex }), { tries: 6, delayMs: 2_000 })));
  if (!matchesPrepared(wallet, steps, txs)) throw new GuardError("these transactions are not the ones that were prepared for your wallet");
  for (const h of hashes) {
    const receipt = await c.waitForTransactionReceipt({ hash: h as Hex, timeout: 90_000, pollingInterval: 1_500 });
    if (receipt.status !== "success") throw new GuardError(`transaction ${h.slice(0, 10)}… failed on chain`);
  }
}

/// Waits until `ok` holds for every strategy's balances: public RPCs can be a
/// block behind right after a transaction.
async function settled(wallet: string, strategies: SelfStrategy[], ok: (b: Amounts) => boolean) {
  for (let i = 0; i < 8; i++) {
    const all = await Promise.all(strategies.map((s) => strategyBalances(wallet, s.hash)));
    if (all.every(ok)) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function ownRow(privyUserId: string, id: string): Promise<SelfRow> {
  const { rows } = await pool.query(`select ${COLUMNS} from self_positions where id = $1 and privy_user_id = $2`, [id, privyUserId]);
  if (!rows[0]) throw Object.assign(new Error("no such position"), { status: 404 });
  return rows[0];
}

export async function recordOpen(account: Account, id: string, hashes: string[]) {
  assertEnabled();
  const row = await ownRow(account.privyUserId, id);
  if (row.status === "open") return viewSelf(row);
  if (row.status !== "pending") throw Object.assign(new Error("this position is already closed"), { status: 409 });
  if (!row.steps) throw new GuardError("this position has no prepared transactions to check");
  await verifySigned(row.wallet, row.steps, hashes);
  if (!(await settled(row.wallet, row.strategies, (b) => b.eth > 0n || b.usdc > 0n)))
    throw new GuardError("the transactions went through, but Aqua does not show the strategies yet: try again in a moment");
  await pool.query("update self_positions set status = 'open', open_txs = $2, opened_at = now() where id = $1 and status = 'pending'", [id, JSON.stringify(hashes)]);
  return viewSelf(await ownRow(account.privyUserId, id));
}

export async function prepareClose(account: Account, id: string) {
  assertEnabled();
  const row = await ownRow(account.privyUserId, id);
  if (row.status !== "open") throw Object.assign(new Error("this position is not open"), { status: 409 });
  const { aqua, router } = deployment();
  return { positionId: id, steps: await withFees(planSelfClose(row.strategies, ARC_PAIR, aqua, router)) };
}

export async function recordClose(account: Account, id: string, hashes: string[]) {
  assertEnabled();
  const row = await ownRow(account.privyUserId, id);
  if (row.status === "closed") return viewSelf(row);
  if (row.status !== "open") throw Object.assign(new Error("this position is not open"), { status: 409 });
  const { aqua, router } = deployment();
  await verifySigned(row.wallet, planSelfClose(row.strategies, ARC_PAIR, aqua, router), hashes); // the docks are rebuilt, not trusted
  if (!(await settled(row.wallet, row.strategies, (b) => b.eth === 0n && b.usdc === 0n)))
    throw new GuardError("the transactions went through, but Aqua still shows balances: try again in a moment");
  await pool.query("update self_positions set status = 'closed', close_txs = $2, closed_at = now() where id = $1 and status = 'open'", [id, JSON.stringify(hashes)]);
  return viewSelf(await ownRow(account.privyUserId, id));
}

export async function listSelf(privyUserId: string) {
  assertEnabled();
  const { rows } = await pool.query(`select ${COLUMNS} from self_positions where privy_user_id = $1 and status in ('open', 'closed') order by created_at desc limit 20`, [privyUserId]);
  const spot = await ethUsd().catch(() => null);
  return Promise.all((rows as SelfRow[]).map((r) => viewSelf(r, spot)));
}

/// A position with its live balances, valued at today's price (display only).
export async function viewSelf(row: SelfRow, spotIn?: number | null) {
  const spot = spotIn === undefined ? await ethUsd().catch(() => null) : spotIn;
  let eth = 0n;
  let usdc = 0n;
  let readable = row.status === "open";
  if (row.status === "open") {
    for (const s of row.strategies) {
      try {
        const b = await strategyBalances(row.wallet, s.hash);
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
    status: row.status,
    mode: row.mode,
    amountUsd: row.amountUsd,
    spotOpen: row.spotOpen,
    priceMin: row.priceMin,
    priceMax: row.priceMax,
    strategies: row.strategies.length,
    weth: Number(formatUnits(eth, 18)),
    usdc: Number(formatUnits(usdc, 6)),
    valueUsd: readable && spot ? valueUsd(eth, usdc, spot, ARC_PAIR) : null,
    openTxs: row.openTxs,
    closeTxs: row.closeTxs,
    createdAt: row.createdAt,
  };
}

