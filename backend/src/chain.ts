import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

const account = config.treasuryPrivateKey ? privateKeyToAccount(config.treasuryPrivateKey as `0x${string}`) : undefined;

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
export async function depositOnChain(user: Address, amount: number) {
  if (!walletClient) throw new Error("chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS");
  const raw = parseUnits(amount.toString(), USDC_DECIMALS);

  const hash = await walletClient.writeContract({
    address: vaultAddress(),
    abi: vaultAbi,
    functionName: "depositFor",
    args: [user, raw],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const value = await previewValueOnChain(user);
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
