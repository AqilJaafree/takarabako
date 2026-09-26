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

// Uniswap v3's canonical Sepolia deployment — not ours, so not env-configured.
// Verified on-chain (factory/NPM cross-checks) before first use — DEPLOYMENTS.md.
const UNISWAP_NPM_ADDRESS: Address = "0x1238536071E1c677A632429e3655c799b22cDA52";
const MAX_UINT128 = 2n ** 128n - 1n;

const npmAbi = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

// The nonce manager tracks the treasury's nonce locally, so several
// transactions can be in flight at once (e.g. two bill-acceptor deposits)
// without each waiting for the previous one to be mined. viem resets it if a
// send fails, so a failed send can't leave a nonce gap.
const account = config.treasuryPrivateKey
  ? privateKeyToAccount(config.treasuryPrivateKey as `0x${string}`, { nonceManager })
  : undefined;

export const chainReady = Boolean(account && config.usdcAddress && config.vaultAddress);
export const treasuryAddress = account?.address;

const publicClient = createPublicClient({
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

const userRegistryAbi = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function findOwner(string label) view returns (address)",
]);

/// Registers `label` as a subname on `registryAddress` (a deployed
/// UserRegistry — DEPLOYMENTS.md — that already owns/subregisters some
/// parent name). Used for both wallet subnames and position subnames
/// under `wantest.eth`; `registry`/`resolver` are left `address(0)` (the
/// PRD's documented safe-placeholder pattern — owner-settable later via
/// `setSubregistry`/`setResolver`, same as `wantest.eth` itself).
export async function registerEnsLabelOnChain(registryAddress: Address, label: string, owner: Address, expiry: bigint) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const zero: Address = "0x0000000000000000000000000000000000000000";

  // register() reverts outright if the label is taken — idempotent by
  // design, not just defensive: our in-memory "is this new?" tracking
  // (store.ts) doesn't survive a backend restart, but the chain's own
  // state does, so a restart replaying an already-registered label must
  // not crash the whole deposit/open-position flow.
  const existingOwner = await publicClient.readContract({
    address: registryAddress,
    abi: userRegistryAbi,
    functionName: "findOwner",
    args: [label],
  });
  if (existingOwner !== zero) {
    return { tokenId: null, txHash: null };
  }

  const { result: tokenId } = await publicClient.simulateContract({
    account: walletClient.account,
    address: registryAddress,
    abi: userRegistryAbi,
    functionName: "register",
    args: [label, owner, zero, zero, 0n, expiry],
  });
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: userRegistryAbi,
    functionName: "register",
    args: [label, owner, zero, zero, 0n, expiry],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { tokenId, txHash: hash };
}

export interface MintPositionParams {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  recipient: Address;
}

/// Phase 3 (PRD §6.4/§7.9): mints a real, new Uniswap v3 LP position NFT —
/// the agent's tier→pool mapping (agent.ts) decides the params; this just
/// executes them. `simulateContract` first because `writeContract` alone
/// only returns a tx hash, not `mint`'s (tokenId, liquidity, amount0,
/// amount1) return values.
export async function mintPositionOnChain(params: MintPositionParams) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const mintArgs = [
    {
      token0: params.token0,
      token1: params.token1,
      fee: params.fee,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      amount0Desired: params.amount0Desired,
      amount1Desired: params.amount1Desired,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: params.recipient,
      deadline,
    },
  ] as const;

  const { result } = await publicClient.simulateContract({
    account: walletClient.account,
    address: UNISWAP_NPM_ADDRESS,
    abi: npmAbi,
    functionName: "mint",
    args: mintArgs,
  });
  const hash = await walletClient.writeContract({
    address: UNISWAP_NPM_ADDRESS,
    abi: npmAbi,
    functionName: "mint",
    args: mintArgs,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const [tokenId, liquidity, amount0, amount1] = result;
  return { tokenId, liquidity, amount0, amount1, txHash: hash };
}

/// Exits a position fully: reads its current liquidity, removes all of it,
/// then collects the underlying tokens (+ any accrued fees) to `recipient`.
/// Two on-chain calls because in Uniswap v3, `decreaseLiquidity` only
/// credits an internal "owed" balance — `collect` is what actually moves
/// the tokens.
export async function exitPositionOnChain(tokenId: bigint, recipient: Address) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const position = await publicClient.readContract({
    address: UNISWAP_NPM_ADDRESS,
    abi: npmAbi,
    functionName: "positions",
    args: [tokenId],
  });
  const liquidity = position[7];

  if (liquidity > 0n) {
    const decreaseArgs = [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }] as const;
    const decreaseHash = await walletClient.writeContract({
      address: UNISWAP_NPM_ADDRESS,
      abi: npmAbi,
      functionName: "decreaseLiquidity",
      args: decreaseArgs,
    });
    await publicClient.waitForTransactionReceipt({ hash: decreaseHash });
  }

  const collectArgs = [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] as const;
  const { result: collected } = await publicClient.simulateContract({
    account: walletClient.account,
    address: UNISWAP_NPM_ADDRESS,
    abi: npmAbi,
    functionName: "collect",
    args: collectArgs,
  });
  const collectHash = await walletClient.writeContract({
    address: UNISWAP_NPM_ADDRESS,
    abi: npmAbi,
    functionName: "collect",
    args: collectArgs,
  });
  await publicClient.waitForTransactionReceipt({ hash: collectHash });

  const [amount0, amount1] = collected;
  return { amount0, amount1, txHash: collectHash };
}
