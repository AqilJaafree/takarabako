import { encodeFunctionData, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { pool } from "./db.js";
import { config, type CashChainKey } from "./config.js";
import { chainOps } from "./chain.js";
import { publishUserEvent } from "./events.js";
import {
  cctpDomain,
  cctpSupported,
  CCTP_TESTNET,
  NO_FEE,
  STANDARD_FINALITY,
  ZERO_BYTES32,
  addressToBytes32,
  fetchAttestation,
} from "./cctp.js";

/// Moving USDC between the cash chains with Circle CCTP V2 (standard transfer).
///
/// A customer transfer: the USDC leaves their box on the source chain (vault
/// withdrawal to the treasury), the treasury burns it with depositForBurn,
/// Circle's attestation service signs the burn, the treasury mints it on the
/// destination chain with receiveMessage, and finally deposits it into the
/// customer's box there. A treasury rebalance is the same without the first
/// and last step.
///
/// Every state change is written to Postgres BEFORE the next step starts, and
/// a step is skipped when its transaction hash is already stored, so a restart
/// resumes a transfer without burning or minting twice.

const tokenMessengerAbi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);
const messageTransmitterAbi = parseAbi(["function receiveMessage(bytes message, bytes attestation) returns (bool)"]);

export type BridgeState = "created" | "withdrawn" | "burned" | "attested" | "minted" | "credited" | "failed";

export interface BridgeTransfer {
  id: string;
  privyUserId: string | null;
  kind: "customer" | "treasury";
  fromChain: CashChainKey;
  toChain: CashChainKey;
  amountUsd: number;
  recipient: string;
  state: BridgeState;
  withdrawTx: string | null;
  burnTx: string | null;
  mintTx: string | null;
  creditTx: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, privy_user_id as "privyUserId", kind, from_chain as "fromChain", to_chain as "toChain", amount_usd::float as "amountUsd",
  recipient, state, withdraw_tx as "withdrawTx", burn_tx as "burnTx", mint_tx as "mintTx", credit_tx as "creditTx", error,
  created_at as "createdAt", updated_at as "updatedAt"`;

export const isTerminal = (s: BridgeState) => s === "credited" || s === "failed";
/// The state where a transfer is done for its kind: customers end credited, treasury rebalances end minted.
export const isDone = (t: Pick<BridgeTransfer, "kind" | "state">) => (t.kind === "customer" ? t.state === "credited" : t.state === "minted" || t.state === "credited") || t.state === "failed";

export class BridgeError extends Error {
  status = 422;
}

export function validateRoute(from: string, to: string): { from: CashChainKey; to: CashChainKey } {
  const ok = (k: string): k is CashChainKey => (config.enabledChains as readonly string[]).includes(k);
  if (!ok(from) || !ok(to)) throw new BridgeError("both chains must be enabled Takarabako chains");
  for (const k of [from, to]) if (!cctpSupported(k)) throw new BridgeError(`${config.chains[k].network.name} has no CCTP route, so USDC can't be bridged to or from it. Top it up from the treasury instead.`);
  if (from === to) throw new BridgeError("pick two different chains");
  for (const k of [from, to]) if (!chainOps(k).chainReady) throw new BridgeError(`${config.chains[k].network.name} isn't configured`);
  return { from, to };
}

export function validateAmount(amount: number) {
  if (!Number.isFinite(amount) || amount < 0.01) throw new BridgeError("the smallest transfer is $0.01");
  if (amount > config.bridge.maxUsd) throw new BridgeError(`one transfer is capped at $${config.bridge.maxUsd.toLocaleString("en-US")}`);
}

export async function getTransfer(id: string): Promise<BridgeTransfer | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from bridge_transfers where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listTransfers(opts: { privyUserId?: string; limit?: number } = {}): Promise<BridgeTransfer[]> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from bridge_transfers where ($1::text is null or privy_user_id = $1) order by created_at desc limit $2`,
    [opts.privyUserId ?? null, opts.limit ?? 20],
  );
  return rows;
}

export async function createTransfer(t: {
  privyUserId: string | null;
  kind: "customer" | "treasury";
  from: CashChainKey;
  to: CashChainKey;
  amountUsd: number;
  recipient: string;
}): Promise<BridgeTransfer> {
  const { rows } = await pool.query(
    `insert into bridge_transfers (id, privy_user_id, kind, from_chain, to_chain, amount_usd, recipient)
     values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
    [crypto.randomUUID(), t.privyUserId, t.kind, t.from, t.to, t.amountUsd, t.recipient],
  );
  return rows[0];
}

async function save(id: string, fields: Record<string, string | null>) {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`update bridge_transfers set ${set}, updated_at = now() where id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function notify(t: BridgeTransfer, state: BridgeState) {
  if (!t.privyUserId) return;
  await publishUserEvent(t.privyUserId, { type: "bridge.update", transferId: t.id, state, fromChain: t.fromChain, toChain: t.toChain, amount: t.amountUsd }).catch(() => {});
}

const rawUsdc = (usd: number) => parseUnits(usd.toFixed(6), 6);

export interface BridgeDeps {
  fetchAttestation: typeof fetchAttestation;
}
const liveDeps: BridgeDeps = { fetchAttestation };

/// Advances a transfer as far as it can go right now. Returns the new state; a
/// transfer waiting on Circle's attestation stays "burned" and is tried again
/// by the worker.
export async function advanceTransfer(id: string, deps: BridgeDeps = liveDeps): Promise<BridgeState> {
  let t = await getTransfer(id);
  if (!t) throw new Error(`bridge transfer ${id} not found`);
  if (isTerminal(t.state)) return t.state;
  const src = chainOps(t.fromChain);
  const dst = chainOps(t.toChain);
  if (!src.treasuryAddress || !dst.treasuryAddress) throw new Error("treasury not configured");
  const treasury = src.treasuryAddress;
  const amount = rawUsdc(t.amountUsd);

  try {
    // 1. USDC out of the customer's box on the source chain, to the treasury.
    if (t.state === "created" && t.kind === "customer") {
      if (!t.withdrawTx) {
        const account = await pool.query("select bound_address from accounts where privy_user_id = $1", [t.privyUserId]);
        const bound = account.rows[0]?.bound_address as Address | undefined;
        if (!bound) throw new Error("account missing");
        const hash = await src.sendWithdrawUsdTx(bound, treasury, t.amountUsd);
        await save(id, { withdraw_tx: hash }); // stored before waiting
        t = { ...t, withdrawTx: hash };
      }
      await src.waitForTx(t.withdrawTx as Hex);
      await save(id, { state: "withdrawn" });
      t = { ...t, state: "withdrawn" };
      await notify(t, "withdrawn");
    }

    // 2. Burn it on the source chain (the treasury is the mint recipient on the other side).
    if ((t.state === "created" && t.kind === "treasury") || t.state === "withdrawn") {
      if (!t.burnTx) {
        if ((await src.treasuryUsdcRaw()) < amount) throw new Error(`the treasury holds less than $${t.amountUsd} USDC on ${config.chains[t.fromChain].network.name}`);
        await src.ensureUsdcAllowance(CCTP_TESTNET.tokenMessenger, amount);
        const hash = await src.sendTreasuryTxNoWait({
          to: CCTP_TESTNET.tokenMessenger,
          data: encodeFunctionData({
            abi: tokenMessengerAbi,
            functionName: "depositForBurn",
            args: [amount, cctpDomain(t.toChain), addressToBytes32(dst.treasuryAddress), config.chains[t.fromChain].usdcAddress as Address, ZERO_BYTES32, NO_FEE, STANDARD_FINALITY],
          }),
        });
        await save(id, { burn_tx: hash });
        t = { ...t, burnTx: hash };
      }
      await src.waitForTx(t.burnTx as Hex);
      await save(id, { state: "burned" });
      t = { ...t, state: "burned" };
      await notify(t, "burned");
    }

    // 3. Circle signs the burn once the source chain is final.
    if (t.state === "burned") {
      const a = await deps.fetchAttestation(config.bridge.attestationUrl, cctpDomain(t.fromChain), t.burnTx!);
      if (!a.ready) return "burned";
      await save(id, { message: a.message, attestation: a.attestation, state: "attested" });
      t = { ...t, state: "attested" };
      await notify(t, "attested");
    }

    // 4. Mint on the destination chain. Anyone may relay a CCTP message, so if it was
    //    already received (by us before a restart, or someone else) that counts as minted.
    if (t.state === "attested") {
      const { rows } = await pool.query("select message, attestation, mint_tx from bridge_transfers where id = $1", [id]);
      let mintTx = rows[0]?.mint_tx as string | null;
      if (!mintTx) {
        try {
          mintTx = await dst.sendTreasuryTxNoWait({
            to: CCTP_TESTNET.messageTransmitter,
            data: encodeFunctionData({ abi: messageTransmitterAbi, functionName: "receiveMessage", args: [rows[0].message, rows[0].attestation] }),
          });
          await save(id, { mint_tx: mintTx });
        } catch (err) {
          if (!/nonce already used/i.test(err instanceof Error ? err.message : String(err))) throw err;
        }
      }
      if (mintTx) await dst.waitForTx(mintTx as Hex);
      await save(id, { state: "minted" });
      t = { ...t, state: "minted", mintTx };
      await notify(t, "minted");
    }

    // 5. Into the customer's box on the destination chain.
    if (t.state === "minted" && t.kind === "customer") {
      if (!t.creditTx) {
        const account = await pool.query("select bound_address from accounts where privy_user_id = $1", [t.privyUserId]);
        const bound = account.rows[0]?.bound_address as Address;
        await dst.ensureVaultApproval();
        const hash = await dst.sendDepositTx(bound, t.amountUsd);
        await save(id, { credit_tx: hash });
        t = { ...t, creditTx: hash };
      }
      await dst.waitForTx(t.creditTx as Hex);
      await save(id, { state: "credited", error: null });
      t = { ...t, state: "credited" };
      await notify(t, "credited");
    }
    return t.state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Before anything left the customer's box it is safe to give up; after that
    // the transfer stays where it is and the worker retries it.
    if (t.state === "created" && !t.withdrawTx && !t.burnTx) {
      await save(id, { state: "failed", error: message });
      await notify(t, "failed");
      return "failed";
    }
    await save(id, { error: message });
    console.error(`[bridge] ${id} stuck in ${t.state}:`, message);
    return t.state;
  }
}

/// Retries transfers that are waiting on an attestation or stuck mid-way.
let advancing = false;
export function startBridgeWorker(intervalMs = 20_000) {
  const tick = async () => {
    if (advancing) return;
    advancing = true;
    try {
      const { rows } = await pool.query("select id from bridge_transfers where state not in ('credited', 'failed') and not (kind = 'treasury' and state = 'minted') order by created_at limit 20");
      for (const r of rows) await advanceTransfer(r.id);
    } catch (err) {
      console.error("[bridge] worker:", err instanceof Error ? err.message : err);
    } finally {
      advancing = false;
    }
  };
  void tick();
  setInterval(tick, intervalMs).unref();
}
