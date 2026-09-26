import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, parseEther, formatUnits, type Address } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";

/// Phase 1 (PRD §7.3/§7.4): real on-chain calls into the deployed
/// TakarabakoVault + MockUSDC on Ethereum Sepolia, signed by the backend's
/// treasury key (env-injected, never on the Pi — PRD §10).

const vaultAbi = parseAbi([
  "function depositFor(address user, uint256 usdcAmount) returns (uint256 shares)",
  "function withdrawTo(address owner, address recipient, uint256 shares) returns (uint256 usdcAmount)",
  "function sharesOf(address user) view returns (uint256)",
  "function previewValue(address user) view returns (uint256 usdcValue)",
  "function currentApyBps() view returns (uint256)",
]);

// USDC uses 6 decimals, not the usual 18 — see contracts/src/mocks/MockUSDC.sol.
const USDC_DECIMALS = 6;

// The nonce manager tracks the treasury's nonce locally, so several
// transactions can be in flight at once (e.g. two bill-acceptor deposits)
// without each waiting for the previous one to be mined. viem resets it if a
// send fails, so a failed send can't leave a nonce gap.
const account = config.treasuryPrivateKey
  ? privateKeyToAccount(config.treasuryPrivateKey as `0x${string}`, { nonceManager })
  : undefined;

export const chainReady = Boolean(account && config.usdcAddress && config.vaultAddress);
export const treasuryAddress = account?.address;

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(config.rpcUrl),
});

const walletClient = account
  ? createWalletClient({
      account,
      chain: sepolia,
      transport: http(config.rpcUrl),
    })
  : undefined;

function vaultAddress(): Address {
  return config.vaultAddress as Address;
}

/// Fronts `amount` (demo units, e.g. 1000 == "$1,000") from the treasury into
/// the vault on behalf of `user`, returns the tx hash and `user`'s live
/// on-chain value (principal — yield hasn't had time to accrue yet).
// Deposit *sends* run one at a time; waiting for the receipt does not. The
// bill acceptor can stack two notes seconds apart. Sent fully concurrently,
// the second deposit's gas was estimated against state the first then
// changed, and it reverted out of gas (Sepolia tx 0x1a8b57b1…). Queueing
// only estimate+send keeps nonces in order while letting both deposits land
// in the same block, instead of the second waiting ~12s for the first.
let sendQueue: Promise<unknown> = Promise.resolve();

function queueSend<T>(send: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(send);
  sendQueue = run.catch(() => {});
  return run;
}

/// For transactions built elsewhere (MultiBaas returns them unsigned —
/// multibaas.ts): same queue, so they never race a viem send for a nonce.
export const queueTreasurySend = queueSend;

/// Signs an unsigned transaction with the treasury key. The fields are
/// MultiBaas's TransactionToSignTx (gas, gasFeeCap/gasTipCap or gasPrice).
/// The nonce comes from our own nonce manager, not the builder: MultiBaas's
/// node may not have seen a send we made a second ago, and sharing one
/// counter keeps both paths in order.
export async function signTreasuryTx(tx: {
  gas: number;
  to?: string | null;
  value: string;
  data: string;
  gasFeeCap?: string;
  gasTipCap?: string;
  gasPrice?: string;
}): Promise<`0x${string}`> {
  if (!account) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY");
  const nonce = await nonceManager.consume({ address: account.address, chainId: sepolia.id, client: publicClient });
  const common = {
    chainId: sepolia.id,
    nonce,
    gas: (BigInt(tx.gas) * 13n) / 10n, // same 30% headroom as our own sends
    to: (tx.to ?? undefined) as Address | undefined,
    value: BigInt(tx.value || 0),
    data: tx.data as `0x${string}`,
  };
  return tx.gasFeeCap
    ? account.signTransaction({
        ...common,
        type: "eip1559",
        maxFeePerGas: BigInt(tx.gasFeeCap),
        maxPriorityFeePerGas: BigInt(tx.gasTipCap ?? 0),
      })
    : account.signTransaction({ ...common, type: "legacy", gasPrice: BigInt(tx.gasPrice ?? 0) });
}

/// After a signed transaction failed to submit, so its nonce isn't burned.
export function resetTreasuryNonce() {
  if (account) nonceManager.reset({ address: account.address, chainId: sepolia.id });
}

export async function waitForTx(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
  if (receipt.status !== "success") throw new Error(`transaction reverted on-chain (tx ${hash})`);
  return receipt;
}

export async function treasuryEthBalance(): Promise<number> {
  if (!account) return 0;
  return Number(formatUnits(await publicClient.getBalance({ address: account.address }), 18));
}

/// Sends depositFor and returns the hash without waiting for it to be mined.
/// The deposit queue stores the hash before waiting, so a retry after a crash
/// waits for this transaction rather than sending another.
export async function sendDepositTx(user: Address, usdAmount: number): Promise<`0x${string}`> {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const request = {
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "depositFor",
    args: [user, parseUnits(usdAmount.toString(), USDC_DECIMALS)],
    account: walletClient.account!,
  } as const;

  // 30% headroom over the estimate, so a small state change between
  // estimation and inclusion can't push the call out of gas.
  return queueSend(async () => {
    const estimate = await publicClient.estimateContractGas(request);
    return walletClient.writeContract({ ...request, gas: (estimate * 13n) / 10n });
  });
}

/// Waits for a deposit tx, throws if it reverted, and returns the user's
/// vault value afterwards.
export async function waitForDepositTx(hash: `0x${string}`, user: Address): Promise<number> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
  if (receipt.status !== "success") throw new Error(`deposit reverted on-chain (tx ${hash})`);
  return previewValueOnChain(user);
}

export async function depositOnChain(user: Address, amount: number) {
  const hash = await sendDepositTx(user, amount);
  const value = await waitForDepositTx(hash, user);
  return { txHash: hash, value };
}

/// Redeems every vault share `user` holds, sending principal + accrued
/// yield to `recipient` (the dev/treasury wallet on withdraw — PRD §6.6).
export async function withdrawAllOnChain(user: Address, recipient: Address) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");

  const shares = await publicClient.readContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "sharesOf",
    args: [user],
  });
  if (shares === 0n) return { txHash: null, amount: 0 };

  // Read the value (principal + accrued yield, at the current exchange
  // rate) before burning the shares — withdrawTo's return value isn't
  // decodable from the tx receipt without an event, and this backend is
  // the only signer, so no other tx can move the rate between these calls.
  const amount = await previewValueOnChain(user);

  const hash = await walletClient.writeContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "withdrawTo",
    args: [user, recipient, shares],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { txHash: hash, amount };
}

/// Sends a transaction built elsewhere (e.g. by the 1inch SDKs) from the
/// treasury, in the shared send queue, without waiting for it to be mined —
/// so several can land in the same block.
export async function sendTreasuryTxNoWait(tx: { to: Address; data: `0x${string}`; value?: bigint }): Promise<`0x${string}`> {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY");
  return queueSend(async () => {
    const gas = await publicClient.estimateGas({ account: walletClient.account!, to: tx.to, data: tx.data, value: tx.value ?? 0n });
    return walletClient.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: (gas * 13n) / 10n });
  });
}

/// Same, and waits for it to be mined.
export async function sendTreasuryTx(tx: { to: Address; data: `0x${string}`; value?: bigint }): Promise<`0x${string}`> {
  const hash = await sendTreasuryTxNoWait(tx);
  await waitForTx(hash);
  return hash;
}

/// Moves `usdAmount` of `user`'s vault value to `recipient` by redeeming
/// the matching share of their vault shares (e.g. into a yield position).
export async function withdrawUsdOnChain(user: Address, recipient: Address, usdAmount: number) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const [shares, value] = await Promise.all([
    publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: "sharesOf", args: [user] }),
    publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: "previewValue", args: [user] }),
  ]);
  const wanted = parseUnits(usdAmount.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  if (wanted > value) throw new Error(`only ${formatUnits(value, USDC_DECIMALS)} USDC in the box`);
  const burn = wanted === value ? shares : (shares * wanted) / value;
  if (burn === 0n) throw new Error("amount too small");
  const hash = await queueSend(() =>
    walletClient.writeContract({ address: vaultAddress(), abi: vaultAbi, functionName: "withdrawTo", args: [user, recipient, burn] }),
  );
  await waitForTx(hash);
  return { txHash: hash };
}

export async function previewValueOnChain(user: Address): Promise<number> {
  const value = await publicClient.readContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "previewValue",
    args: [user],
  });
  return Number(formatUnits(value, USDC_DECIMALS));
}

export async function currentApyBpsOnChain(): Promise<number> {
  const bps = await publicClient.readContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "currentApyBps",
  });
  return Number(bps);
}

/// Sends real Sepolia ETH from the treasury to a freshly-created Privy
/// embedded wallet so the user has gas for anything they do with it
/// themselves later. Real capital, not a mock token — see privy.ts for
/// where this is gated to first-time account creation only, not every
/// login, to keep spend bounded.
export async function fundWalletWithEthOnChain(recipient: Address, amountEth: number) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const hash = await walletClient.sendTransaction({
    to: recipient,
    value: parseEther(amountEth.toString()),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { txHash: hash };
}

