import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, parseEther, formatUnits, type Address } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { config, type ChainConfig, type CashChainKey } from "./config.js";
import { applyFeeFloor, type Fees } from "./networks.js";

/// Real on-chain calls into a deployed TakarabakoVault + USDC, signed by the
/// backend's treasury key (env-injected, never on the Pi — PRD §10). One
/// ChainOps per chain (Ethereum Sepolia, Arc Testnet): each has its own
/// clients, its own send queue and its own nonce, so the two chains never
/// wait on each other. The unprefixed exports at the bottom are the primary
/// chain's (CHAIN), which keeps single-chain callers unchanged.

export function createChainOps(cfg: ChainConfig) {
  const vaultAbi = parseAbi([
    "function depositFor(address user, uint256 usdcAmount) returns (uint256 shares)",
    "function withdrawTo(address owner, address recipient, uint256 shares) returns (uint256 usdcAmount)",
    "function sharesOf(address user) view returns (uint256)",
    "function previewValue(address user) view returns (uint256 usdcValue)",
    "function currentApyBps() view returns (uint256)",
  ]);

  /// Arc drops transactions whose maxFeePerGas is under its mempool floor
  /// (20 gwei) without any error, so sends on Arc carry at least that. Other
  /// networks get no overrides.
  async function feeOverrides(): Promise<Fees> {
    if (cfg.network.minMaxFeePerGas === 0n) return {};
    return applyFeeFloor(await publicClient.estimateFeesPerGas(), cfg.network.minMaxFeePerGas);
  }

  // USDC uses 6 decimals, not the usual 18 — see contracts/src/mocks/MockUSDC.sol.
  const USDC_DECIMALS = 6;

  // The nonce manager tracks the treasury's nonce locally, so several
  // transactions can be in flight at once (e.g. two bill-acceptor deposits)
  // without each waiting for the previous one to be mined. viem resets it if a
  // send fails, so a failed send can't leave a nonce gap.
  const account = config.treasuryPrivateKey
    ? privateKeyToAccount(config.treasuryPrivateKey as `0x${string}`, { nonceManager })
    : undefined;

  const chainReady = Boolean(account && cfg.usdcAddress && cfg.vaultAddress);
  const treasuryAddress = account?.address;

  // Public testnet RPCs rate-limit bursts and return the odd 502. viem's default backoff (150ms) is
  // used up within a burst, so wait longer: 0.6s, 1.2s, 2.4s, 4.8s.
  const transport = () => http(cfg.rpcUrl, { retryCount: 4, retryDelay: 600 });

  const publicClient = createPublicClient({
    chain: cfg.network.chain,
    transport: transport(),
  });

  const walletClient = account
    ? createWalletClient({
        account,
        chain: cfg.network.chain,
        transport: transport(),
      })
    : undefined;

  function vaultAddress(): Address {
    return cfg.vaultAddress as Address;
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
  const queueTreasurySend = queueSend;

  /// Signs an unsigned transaction with the treasury key. The fields are
  /// MultiBaas's TransactionToSignTx (gas, gasFeeCap/gasTipCap or gasPrice).
  /// The nonce comes from our own nonce manager, not the builder: MultiBaas's
  /// node may not have seen a send we made a second ago, and sharing one
  /// counter keeps both paths in order.
  async function signTreasuryTx(tx: {
    gas: number;
    to?: string | null;
    value: string;
    data: string;
    gasFeeCap?: string;
    gasTipCap?: string;
    gasPrice?: string;
  }): Promise<`0x${string}`> {
    if (!account) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY");
    const nonce = await nonceManager.consume({ address: account.address, chainId: cfg.network.chain.id, client: publicClient });
    const common = {
      chainId: cfg.network.chain.id,
      nonce,
      gas: (BigInt(tx.gas) * 13n) / 10n, // same 30% headroom as our own sends
      to: (tx.to ?? undefined) as Address | undefined,
      value: BigInt(tx.value || 0),
      data: tx.data as `0x${string}`,
    };
    const floor = cfg.network.minMaxFeePerGas;
    if (tx.gasFeeCap) {
      const fees = applyFeeFloor({ maxFeePerGas: BigInt(tx.gasFeeCap), maxPriorityFeePerGas: BigInt(tx.gasTipCap ?? 0) }, floor);
      return account.signTransaction({ ...common, type: "eip1559", maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! });
    }
    const gasPrice = BigInt(tx.gasPrice ?? 0);
    return account.signTransaction({ ...common, type: "legacy", gasPrice: gasPrice > floor ? gasPrice : floor });
  }

  /// After a signed transaction failed to submit, so its nonce isn't burned.
  function resetTreasuryNonce() {
    if (account) nonceManager.reset({ address: account.address, chainId: cfg.network.chain.id });
  }

  async function waitForTx(hash: `0x${string}`) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
    if (receipt.status !== "success") throw new Error(`transaction reverted on-chain (tx ${hash})`);
    return receipt;
  }

  async function treasuryEthBalance(): Promise<number> {
    if (!account) return 0;
    return Number(formatUnits(await publicClient.getBalance({ address: account.address }), 18));
  }

  /// Sends depositFor and returns the hash without waiting for it to be mined.
  /// The deposit queue stores the hash before waiting, so a retry after a crash
  /// waits for this transaction rather than sending another.
  async function sendDepositTx(user: Address, usdAmount: number): Promise<`0x${string}`> {
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
      return walletClient.writeContract({ ...request, gas: (estimate * 13n) / 10n, ...(await feeOverrides()) });
    });
  }

  /// Waits for a deposit tx, throws if it reverted, and returns the user's
  /// vault value afterwards.
  async function waitForDepositTx(hash: `0x${string}`, user: Address): Promise<number> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
    if (receipt.status !== "success") throw new Error(`deposit reverted on-chain (tx ${hash})`);
    return previewValueOnChain(user);
  }

  async function depositOnChain(user: Address, amount: number) {
    const hash = await sendDepositTx(user, amount);
    const value = await waitForDepositTx(hash, user);
    return { txHash: hash, value };
  }

  /// Redeems every vault share `user` holds, sending principal + accrued
  /// yield to `recipient` (the dev/treasury wallet on withdraw — PRD §6.6).
  async function withdrawAllOnChain(user: Address, recipient: Address) {
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
      ...(await feeOverrides()),
    });
    await publicClient.waitForTransactionReceipt({ hash });

    return { txHash: hash, amount };
  }

  /// Sends a transaction built elsewhere (e.g. by the 1inch SDKs) from the
  /// treasury, in the shared send queue, without waiting for it to be mined —
  /// so several can land in the same block.
  async function sendTreasuryTxNoWait(tx: { to: Address; data: `0x${string}`; value?: bigint }): Promise<`0x${string}`> {
    if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY");
    return queueSend(async () => {
      const gas = await publicClient.estimateGas({ account: walletClient.account!, to: tx.to, data: tx.data, value: tx.value ?? 0n });
      return walletClient.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: (gas * 13n) / 10n, ...(await feeOverrides()) });
    });
  }

  /// Same, and waits for it to be mined.
  async function sendTreasuryTx(tx: { to: Address; data: `0x${string}`; value?: bigint }): Promise<`0x${string}`> {
    const hash = await sendTreasuryTxNoWait(tx);
    await waitForTx(hash);
    return hash;
  }

  /// Moves `usdAmount` of `user`'s vault value to `recipient` by redeeming
  /// the matching share of their vault shares (e.g. into a yield position).
  /// Resolves with the hash as soon as the transaction is sent, so a caller
  /// can store it before waiting.
  async function sendWithdrawUsdTx(user: Address, recipient: Address, usdAmount: number): Promise<`0x${string}`> {
    if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
    const [shares, value] = await Promise.all([
      publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: "sharesOf", args: [user] }),
      publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: "previewValue", args: [user] }),
    ]);
    const wanted = parseUnits(usdAmount.toFixed(USDC_DECIMALS), USDC_DECIMALS);
    if (wanted > value) throw new Error(`only ${formatUnits(value, USDC_DECIMALS)} USDC in the box on ${cfg.network.name}`);
    const burn = wanted === value ? shares : (shares * wanted) / value;
    if (burn === 0n) throw new Error("amount too small");
    return queueSend(async () =>
      walletClient.writeContract({ address: vaultAddress(), abi: vaultAbi, functionName: "withdrawTo", args: [user, recipient, burn], ...(await feeOverrides()) }),
    );
  }

  async function withdrawUsdOnChain(user: Address, recipient: Address, usdAmount: number) {
    const hash = await sendWithdrawUsdTx(user, recipient, usdAmount);
    await waitForTx(hash);
    return { txHash: hash };
  }

  /// The treasury's ERC-20 USDC allowance for `spender`, raised to max if it is low
  /// (used for the CCTP TokenMessenger).
  async function ensureUsdcAllowance(spender: Address, needed: bigint): Promise<void> {
    if (!walletClient || !account) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY");
    const erc20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
    const current = await publicClient.readContract({ address: cfg.usdcAddress as Address, abi: erc20, functionName: "allowance", args: [account.address, spender] });
    if (current >= needed) return;
    const hash = await queueSend(async () =>
      walletClient.writeContract({ address: cfg.usdcAddress as Address, abi: erc20, functionName: "approve", args: [spender, 2n ** 256n - 1n], ...(await feeOverrides()) }),
    );
    await waitForTx(hash);
  }

  /// The treasury's USDC (ERC-20 view, 6 decimals) on this chain, raw.
  async function treasuryUsdcRaw(): Promise<bigint> {
    if (!account) return 0n;
    return publicClient.readContract({
      address: cfg.usdcAddress as Address,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [account.address],
    });
  }

  /// The vault pulls USDC from the treasury (depositFor, fundYieldReserve), so
  /// the treasury must have approved it. Sends a max approval once if needed;
  /// a no-op when the allowance is already large.
  async function ensureVaultApproval(): Promise<void> {
    if (!walletClient || !account) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
    const erc20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
    const current = await publicClient.readContract({ address: cfg.usdcAddress as Address, abi: erc20, functionName: "allowance", args: [account.address, vaultAddress()] });
    if (current >= 10n ** 15n) return;
    const hash = await queueSend(async () =>
      walletClient.writeContract({ address: cfg.usdcAddress as Address, abi: erc20, functionName: "approve", args: [vaultAddress(), 2n ** 256n - 1n], ...(await feeOverrides()) }),
    );
    await waitForTx(hash);
  }

  async function previewValueOnChain(user: Address): Promise<number> {
    const value = await publicClient.readContract({
      address: vaultAddress(),
      abi: vaultAbi,
      functionName: "previewValue",
      args: [user],
    });
    return Number(formatUnits(value, USDC_DECIMALS));
  }

  async function currentApyBpsOnChain(): Promise<number> {
    const bps = await publicClient.readContract({
      address: vaultAddress(),
      abi: vaultAbi,
      functionName: "currentApyBps",
    });
    return Number(bps);
  }

  /// Sends the network's native token (Sepolia ETH; native USDC on Arc) from the treasury to a freshly-created Privy
  /// embedded wallet so the user has gas for anything they do with it
  /// themselves later. Real capital, not a mock token — see privy.ts for
  /// where this is gated to first-time account creation only, not every
  /// login, to keep spend bounded.
  async function fundWalletWithEthOnChain(recipient: Address, amountEth: number) {
    if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
    const hash = await walletClient.sendTransaction({
      to: recipient,
      value: parseEther(amountEth.toString()),
      ...(await feeOverrides()),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  return { key: cfg.key, cfg, chainReady, treasuryAddress, publicClient, queueTreasurySend, signTreasuryTx, resetTreasuryNonce, waitForTx, treasuryEthBalance, sendDepositTx, waitForDepositTx, depositOnChain, withdrawAllOnChain, sendTreasuryTxNoWait, sendTreasuryTx, withdrawUsdOnChain, previewValueOnChain, currentApyBpsOnChain, fundWalletWithEthOnChain, ensureVaultApproval, sendWithdrawUsdTx, ensureUsdcAllowance, treasuryUsdcRaw };
}

export type ChainOps = ReturnType<typeof createChainOps>;

/// The configuration the legacy single-chain exports run on: the primary chain
/// (CHAIN) with the unprefixed variables.
const primaryConfig: ChainConfig = {
  key: config.defaultChain,
  network: config.network,
  rpcUrl: config.rpcUrl,
  usdcAddress: config.usdcAddress,
  vaultAddress: config.vaultAddress,
  cashReceiptAddress: config.cashReceiptAddress,
  indexFromBlock: "",
};
const primary = createChainOps(primaryConfig);
const byKey = new Map<CashChainKey, ChainOps>();

/// Ops for one cash chain. The primary chain reuses the primary instance, so
/// there is only ever one send queue per chain.
export function chainOps(key: CashChainKey = config.defaultChain): ChainOps {
  let ops = byKey.get(key);
  if (!ops) {
    ops = config.chains[key].network.key === config.network.key ? primary : createChainOps(config.chains[key]);
    byKey.set(key, ops);
  }
  return ops;
}

/// Enabled chains whose treasury, USDC and vault are all configured.
export function readyChains(): CashChainKey[] {
  return config.enabledChains.filter((k) => chainOps(k).chainReady);
}

export const {
  chainReady, treasuryAddress, publicClient, queueTreasurySend, signTreasuryTx, resetTreasuryNonce, waitForTx, treasuryEthBalance,
  sendDepositTx, waitForDepositTx, depositOnChain, withdrawAllOnChain, sendTreasuryTxNoWait, sendTreasuryTx, withdrawUsdOnChain,
  previewValueOnChain, currentApyBpsOnChain, fundWalletWithEthOnChain, ensureVaultApproval, sendWithdrawUsdTx,
} = primary;
