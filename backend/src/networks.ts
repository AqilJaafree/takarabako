import { arc, arcTestnet, hederaTestnet, sepolia } from "viem/chains";
import type { Chain } from "viem";
import { aq, sv } from "./aquaSdk.js";

/// The chains the backend can run on, selected with CHAIN. Pure data and
/// helpers (no config import), so the choices are unit-tested.
///
/// Arc values are from https://docs.arc.io/arc/references/connect-to-arc and
/// .../contract-addresses: Arc Testnet is chain 5042002, Arc mainnet 5042,
/// gas is paid in native USDC (18 decimals) while the ERC-20 USDC at
/// 0x3600…0000 has 6, and the mempool drops transactions whose maxFeePerGas
/// is under 20 gwei.
///
/// Hedera (EVM side, through the JSON-RPC relay): testnet is chain 296, gas is
/// HBAR shown with 18 decimals (weibars) by the relay, and USDC is Circle's
/// native Hedera Token Service token 0.0.429274 (6 decimals) reached through
/// its ERC-20 facade at 0x…068cda (checked against the testnet mirror node and
/// relay). There is no CCTP route to Hedera.

export type NetworkKey = "sepolia" | "arc-testnet" | "hedera-testnet" | "arc";

export interface Network {
  key: NetworkKey;
  name: string;
  chain: Chain;
  defaultRpcUrl: string;
  /// What pays gas on this chain.
  nativeSymbol: string;
  explorerUrl: string;
  /// Mempool minimum for maxFeePerGas (0 = no floor).
  minMaxFeePerGas: bigint;
  /// Real money: a mainnet, as opposed to a testnet with worthless tokens.
  real: boolean;
  /// Native-token amounts for gas: a customer wallet under `minBalance` is topped up by
  /// `topUp`; the ops dashboard warns when the treasury drops under `treasuryMin`.
  gas: { minBalance: number; topUp: number; treasuryMin: number };
  /// Largest block span one eth_getLogs call may cover (the Hedera relay answers "Exceeded
  /// maximum block range: 1000" beyond that).
  logBatchBlocks: bigint;
  /// Token addresses known from the chain's official docs ("" = set in env).
  defaults: { usdc: string; baseToken: string };
}

const GWEI = 1_000_000_000n;

export const NETWORKS: Record<NetworkKey, Network> = {
  sepolia: {
    key: "sepolia",
    name: "Ethereum Sepolia",
    chain: sepolia,
    defaultRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    nativeSymbol: "ETH",
    explorerUrl: "https://sepolia.etherscan.io",
    minMaxFeePerGas: 0n,
    real: false,
    gas: { minBalance: 0.0005, topUp: 0.001, treasuryMin: 0.05 },
    logBatchBlocks: 2_000n,
    // Our own MockUSDC and mETH are deployed here; USDC_ADDRESS comes from env.
    defaults: { usdc: "", baseToken: "0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282" },
  },
  "arc-testnet": {
    key: "arc-testnet",
    name: "Arc Testnet",
    chain: arcTestnet,
    defaultRpcUrl: "https://rpc.testnet.arc.io",
    nativeSymbol: "USDC",
    explorerUrl: "https://explorer.testnet.arc.io",
    minMaxFeePerGas: 20n * GWEI,
    real: false,
    gas: { minBalance: 0.0005, topUp: 0.001, treasuryMin: 1 },
    logBatchBlocks: 2_000n,
    // USDC (6 decimals as ERC-20) and bridged WETH (18), per the contract-addresses page.
    defaults: { usdc: "0x3600000000000000000000000000000000000000", baseToken: "0x2c4047028a72803939b6fb674D01bC059B5C4961" },
  },
  "hedera-testnet": {
    key: "hedera-testnet",
    name: "Hedera Testnet",
    chain: hederaTestnet,
    defaultRpcUrl: "https://testnet.hashio.io/api",
    nativeSymbol: "HBAR",
    explorerUrl: "https://hashscan.io/testnet",
    // The relay's blocks carry a base fee, so the usual estimate is enough.
    minMaxFeePerGas: 0n,
    real: false,
    // A transaction costs a fraction of an HBAR at the relay's gas price.
    gas: { minBalance: 0.5, topUp: 1, treasuryMin: 20 },
    logBatchBlocks: 900n,
    // Circle USDC (HTS 0.0.429274) through its ERC-20 facade. No Aqua deployment here.
    defaults: { usdc: "0x0000000000000000000000000000000000068cda", baseToken: "" },
  },
  arc: {
    key: "arc",
    name: "Arc",
    chain: arc,
    defaultRpcUrl: "https://rpc.mainnet.arc.io",
    nativeSymbol: "USDC",
    explorerUrl: "https://explorer.arc.io",
    minMaxFeePerGas: 20n * GWEI,
    real: true,
    gas: { minBalance: 0.0005, topUp: 0.001, treasuryMin: 1 },
    logBatchBlocks: 2_000n,
    // Mainnet token addresses were not verified: set USDC_ADDRESS / METH_ADDRESS.
    defaults: { usdc: "", baseToken: "" },
  },
};

export function resolveNetwork(key: string | undefined): Network {
  const k = (key?.trim() || "sepolia") as NetworkKey;
  const n = NETWORKS[k];
  if (!n) throw new Error(`unknown CHAIN "${key}" — use one of: ${Object.keys(NETWORKS).join(", ")}`);
  return n;
}

/// ---- 1inch Aqua deployments -------------------------------------------------

/// Sepolia is not in the SDK's per-chain maps. The Aqua registry is at the
/// shared address; the SwapVM router there is the earlier deployment.
const SEPOLIA_AQUA = { aqua: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", router: "0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de" };

export interface AquaDeployment {
  aqua: string;
  router: string;
  /// Where the addresses came from: an env override, the SDK's per-chain
  /// maps, or the built-in Sepolia pair.
  origin: "env" | "sdk" | "sepolia";
}

const fromSdk = (map: Record<number, { toString(): string }> | undefined, chainId: number): string | undefined => {
  const v = map?.[chainId];
  return v ? v.toString().toLowerCase() : undefined;
};

/// Aqua registry + SwapVM router for a chain: env overrides first, then the
/// official SDK's address maps (@1inch/aqua-sdk AQUA_CONTRACT_ADDRESSES and
/// @1inch/swap-vm-sdk AQUA_SWAP_VM_CONTRACT_ADDRESSES). null = not available.
export function resolveAquaDeployment(chainId: number, env: { aqua?: string; router?: string } = {}): AquaDeployment | null {
  const sdkAqua = fromSdk(aq.AQUA_CONTRACT_ADDRESSES as never, chainId);
  const sdkRouter = fromSdk(sv.AQUA_SWAP_VM_CONTRACT_ADDRESSES as never, chainId);
  const legacy = chainId === sepolia.id ? SEPOLIA_AQUA : undefined;

  const aqua = env.aqua?.trim() || sdkAqua || legacy?.aqua;
  const router = env.router?.trim() || sdkRouter || legacy?.router;
  if (!aqua || !router) return null;

  const overridden = Boolean(env.aqua?.trim() || env.router?.trim());
  const origin = overridden ? "env" : sdkAqua && sdkRouter ? "sdk" : "sepolia";
  return { aqua, router, origin };
}

/// ---- fees -------------------------------------------------------------------

export interface Fees {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/// Raises maxFeePerGas to the network's mempool floor (Arc silently drops
/// anything under 20 gwei) and keeps the tip within it. No floor = no change.
export function applyFeeFloor(fees: Fees, floor: bigint): Fees {
  if (floor === 0n) return fees;
  const max = fees.maxFeePerGas !== undefined && fees.maxFeePerGas > floor ? fees.maxFeePerGas : floor;
  const tip = fees.maxPriorityFeePerGas ?? 0n;
  return { maxFeePerGas: max, maxPriorityFeePerGas: tip > max ? max : tip };
}

/// ---- what the web app is told about each network ----------------------------

export interface NetworkInfo {
  key: NetworkKey;
  name: string;
  chainId: number;
  nativeSymbol: string;
  explorerUrl: string;
  feeFloorGwei: number;
  real: boolean;
  /// Token addresses known from the chain's docs ("" = not set up yet).
  usdc: string;
  baseToken: string;
  /// Where Aqua + the SwapVM router are, or null when not deployed.
  aqua: AquaDeployment | null;
  /// The one network this backend can open and close real positions on.
  active: boolean;
}

/// Every network, with its Aqua deployment. Env overrides (AQUA_ADDRESS,
/// AQUA_ROUTER_ADDRESS, USDC_ADDRESS, METH_ADDRESS) belong to the active
/// network only, so the other networks show what the SDK and docs say.
export function describeNetworks(
  activeKey: NetworkKey,
  env: { aqua?: string; router?: string; usdc?: string; baseToken?: string } = {},
): NetworkInfo[] {
  return (Object.values(NETWORKS) as Network[]).map((n) => {
    const active = n.key === activeKey;
    return {
      key: n.key,
      name: n.name,
      chainId: n.chain.id,
      nativeSymbol: n.nativeSymbol,
      explorerUrl: n.explorerUrl,
      feeFloorGwei: Number(n.minMaxFeePerGas) / 1e9,
      real: n.real,
      usdc: (active && env.usdc) || n.defaults.usdc,
      baseToken: (active && env.baseToken) || n.defaults.baseToken,
      aqua: resolveAquaDeployment(n.chain.id, active ? { aqua: env.aqua, router: env.router } : {}),
      active,
    };
  });
}

/// ---- what the yield page may show ------------------------------------------------

/// The yield tiers' APY figures are rough guesses from range width, fine as
/// a demo on a testnet and not something to show a customer whose real money
/// is at stake. They are hidden on a real-money network unless SHOW_APY_ESTIMATES=1
/// turns them back on (or =0 hides them on a testnet too).
export function showApyEstimates(real: boolean, override?: string): boolean {
  if (override === "1") return true;
  if (override === "0") return false;
  return !real;
}
