import { decodeEventLog, parseAbi, type Address } from "viem";
import { pool } from "./db.js";
import { config, type CashChainKey } from "./config.js";
import { findByPrivyUserId, type Account } from "./accounts.js";
import { chainOps } from "./chain.js";
import { cashReceiptReadyOn, fromTkUnits, tkRead } from "./cashReceipt.js";
import { findCustomer, isAddress } from "./labels.js";
import { assertWithinLimit } from "./limits.js";

/// Sending to another customer, by wallet address or label (both looked up in
/// Postgres, no name service involved).
///   box balance: moved by the backend (vault shares out of one box, into another)
///   tkCASH:      signed by the sender in their own wallet (web app); recorded here
/// Both happen on one chain; a transfer never crosses chains (the bridge does that).

export interface Resolved {
  /// What the sender typed, normalised: a label or an address.
  query: string;
  address: string;
  /// The recipient's label when they are a Takarabako customer.
  label: string | null;
  customer: boolean;
  tkcashAllowlisted: boolean | null;
}

export async function lookup(q: string, chain: CashChainKey = config.defaultChain): Promise<Resolved | null> {
  const query = q.trim().toLowerCase();
  const found = await findCustomer(query);
  const address = found?.wallet ?? (isAddress(query) ? query : null);
  if (!address) return null;
  const allowlisted = cashReceiptReadyOn(chain)
    ? await tkRead<boolean>(chain, "allowlist", [address]).catch(() => null)
    : null;
  return { query, address, label: found?.label ?? null, customer: Boolean(found), tkcashAllowlisted: allowlisted };
}

async function record(t: {
  kind: "balance" | "tkcash";
  from: string | null;
  to: string | null;
  toName?: string | null;
  toAddress?: string | null;
  amountUsd?: number | null;
  txHash?: string | null;
  chain: CashChainKey;
}) {
  await pool.query(
    `insert into transfers (id, kind, from_user, to_user, to_name, to_address, amount_usd, tx_hash, chain)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
    [crypto.randomUUID(), t.kind, t.from, t.to, t.toName ?? null, t.toAddress ?? null, t.amountUsd ?? null, t.txHash ?? null, t.chain],
  );
}

/// Box balance to another customer. Custodial: the vault is ours.
export async function sendBalance(from: Account, to: string, amount: number, chain: CashChainKey = config.defaultChain) {
  await assertWithinLimit(from, amount, "this send");
  const target = await lookup(to, chain);
  if (!target) throw new Error(`${to} isn't a label or wallet address we know`);
  const recipient = target.customer ? await findCustomer(target.address) : null;
  const account = recipient ? await findByPrivyUserId(recipient.privyUserId) : null;
  if (!account) throw new Error(`${to} isn't a Takarabako customer, so box balance can only go to another box`);
  if (account.privyUserId === from.privyUserId) throw new Error("that's your own box");
  const ops = chainOps(chain);
  if (!ops.treasuryAddress) throw new Error(`${chain} isn't configured`);
  // Out of the sender's vault shares, into the recipient's.
  await ops.withdrawUsdOnChain(from.boundAddress as Address, ops.treasuryAddress, amount);
  const { txHash } = await ops.depositOnChain(account.boundAddress as Address, amount);
  await record({ kind: "balance", from: from.privyUserId, to: account.privyUserId, toName: target.label, toAddress: target.address, amountUsd: amount, txHash, chain });
  return { to: target, txHash, chain };
}

const tkcashTransfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/// Records a tkCASH transfer the customer signed in their own wallet, after
/// checking the transaction really moved tkCASH from them.
export async function confirmTkcashSend(from: Account, txHash: string, chain: CashChainKey, toLabel: string | null) {
  const receipt = await chainOps(chain).publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("the transfer reverted on-chain");
  const log = receipt.logs.find((l) => l.address.toLowerCase() === config.chains[chain].cashReceiptAddress.toLowerCase());
  if (!log) throw new Error("no tkCASH transfer in that transaction");
  const ev = decodeEventLog({ abi: tkcashTransfer, data: log.data, topics: log.topics });
  if (ev.args.from.toLowerCase() !== from.privyWallet.toLowerCase()) throw new Error("that transfer wasn't from your wallet");
  const to = await findCustomer(ev.args.to);
  const amountUsd = fromTkUnits(ev.args.value);
  await record({ kind: "tkcash", from: from.privyUserId, to: to?.privyUserId ?? null, toName: toLabel, toAddress: ev.args.to, amountUsd, txHash, chain });
  return { to: ev.args.to, amountUsd, toCustomer: to?.label ?? null, chain };
}

// Customers pay gas for transfers they sign (ETH on Sepolia, USDC on Arc); top
// their wallet up when low, at most hourly per chain.
const lastTopUp = new Map<string, number>();

export async function ensureGas(account: Account, chain: CashChainKey = config.defaultChain) {
  const ops = chainOps(chain);
  const wei = await ops.publicClient.getBalance({ address: account.privyWallet as Address });
  const balance = Number(wei) / 1e18; // 18 decimals on both: Sepolia ETH, and Arc's native USDC gas view
  if (balance >= config.chains[chain].network.gas.minBalance) return { balance, toppedUp: false, symbol: config.chains[chain].network.nativeSymbol };
  const key = `${chain}:${account.privyUserId}`;
  const last = lastTopUp.get(key) ?? 0;
  if (Date.now() - last < 3600_000 || !ops.chainReady) return { balance, toppedUp: false, symbol: config.chains[chain].network.nativeSymbol };
  lastTopUp.set(key, Date.now());
  const { txHash } = await ops.fundWalletWithEthOnChain(account.privyWallet as Address, config.chains[chain].network.gas.topUp);
  return { balance: balance + config.chains[chain].network.gas.topUp, toppedUp: true, txHash, symbol: config.chains[chain].network.nativeSymbol };
}
